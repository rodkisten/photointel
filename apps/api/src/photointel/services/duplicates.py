"""Non-destructive duplicate candidates from indexed, bounded comparisons."""

from datetime import timedelta
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.models import Asset, AuditEvent, DuplicateGroup, DuplicateMember


def hash_distance(left: str, right: str) -> int:
    if len(left) != 16 or len(right) != 16:
        raise ValueError("Expected 64-bit pHash hexadecimal values")
    return (int(left, 16) ^ int(right, 16)).bit_count()


def representative_score(asset: Asset) -> tuple[int, float, int]:
    return (
        (asset.width or 0) * (asset.height or 0),
        float(asset.quality.get("sharpness_laplacian_variance", 0)),
        asset.filesize or 0,
    )


async def _persist_group(
    session: AsyncSession,
    group_key: str,
    kind: str,
    members: list[tuple[Asset, float]],
    threshold: float | None,
) -> UUID:
    best = max(members, key=lambda pair: representative_score(pair[0]))[0]
    identifier = uuid4()
    await session.execute(
        insert(DuplicateGroup)
        .values(
            id=identifier,
            group_key=group_key,
            duplicate_type=kind,
            representative_asset_id=best.id,
            threshold=threshold,
            algorithm="sha256" if kind == "exact" else "phash_bounded_candidates",
        )
        .on_conflict_do_nothing(index_elements=[DuplicateGroup.group_key])
    )
    group = await session.scalar(
        select(DuplicateGroup)
        .where(
            DuplicateGroup.group_key == group_key,
        )
        .with_for_update()
    )
    assert group is not None
    existing_best = await session.scalar(
        select(Asset)
        .join(
            DuplicateMember,
            DuplicateMember.asset_id == Asset.id,
        )
        .where(DuplicateMember.group_id == group.id)
        .order_by(
            (Asset.width * Asset.height).desc().nullslast(),
            Asset.quality["sharpness_laplacian_variance"].as_float().desc().nullslast(),
            Asset.filesize.desc().nullslast(),
            Asset.id,
        )
        .limit(1)
    )
    if existing_best is not None:
        best = max([best, existing_best], key=representative_score)
    previous_representative = group.representative_asset_id
    if previous_representative and previous_representative != best.id:
        await session.execute(
            update(DuplicateMember)
            .where(
                DuplicateMember.group_id == group.id,
                DuplicateMember.asset_id == previous_representative,
            )
            .values(quality_rank=None)
        )
    group.representative_asset_id = best.id
    ranked = sorted(members, key=lambda item: representative_score(item[0]), reverse=True)
    for asset, similarity in ranked:
        await session.execute(
            insert(DuplicateMember)
            .values(
                group_id=group.id,
                asset_id=asset.id,
                similarity=similarity,
                quality_rank=1 if asset.id == best.id else None,
            )
            .on_conflict_do_update(
                index_elements=[DuplicateMember.group_id, DuplicateMember.asset_id],
                set_={
                    "similarity": similarity,
                    "quality_rank": 1 if asset.id == best.id else None,
                },
            )
        )
    return group.id


async def invalidate_duplicate_memberships(
    session: AsyncSession,
    asset_id: UUID,
) -> None:
    """Remove stale derived grouping after an edit; never remove photos or resources.

    All grouping changes happen in SQL. An asset with many candidate pairs must
    not cause the entire group membership list to be loaded into Python memory.
    """
    affected = select(DuplicateMember.group_id).where(
        DuplicateMember.asset_id == asset_id,
    )
    replacement = (
        select(Asset.id)
        .join(
            DuplicateMember,
            DuplicateMember.asset_id == Asset.id,
        )
        .where(
            DuplicateMember.group_id == DuplicateGroup.id,
            Asset.id != asset_id,
        )
        .order_by(
            (Asset.width * Asset.height).desc().nullslast(),
            Asset.quality["sharpness_laplacian_variance"].as_float().desc().nullslast(),
            Asset.filesize.desc().nullslast(),
            Asset.id,
        )
        .limit(1)
        .correlate(DuplicateGroup)
        .scalar_subquery()
    )
    await session.execute(
        update(DuplicateGroup)
        .where(
            DuplicateGroup.id.in_(affected),
            DuplicateGroup.representative_asset_id == asset_id,
        )
        .values(representative_asset_id=replacement)
        .execution_options(
            synchronize_session=False,
        )
    )
    member_count = (
        select(func.count())
        .select_from(DuplicateMember)
        .where(
            DuplicateMember.group_id == DuplicateGroup.id,
        )
        .correlate(DuplicateGroup)
        .scalar_subquery()
    )
    await session.execute(
        delete(DuplicateGroup)
        .where(
            DuplicateGroup.id.in_(affected),
            member_count <= 2,
        )
        .execution_options(synchronize_session=False)
    )
    await session.execute(
        delete(DuplicateMember)
        .where(
            DuplicateMember.asset_id == asset_id,
        )
        .execution_options(synchronize_session=False)
    )
    session.add(
        AuditEvent(
            actor="worker",
            action="duplicates.invalidated",
            asset_id=asset_id,
            details={"reason": "source_representation_changed"},
        )
    )


async def analyze_duplicates(
    session: AsyncSession,
    asset: Asset,
    threshold: int = 6,
) -> dict[str, Any]:
    if not 0 <= threshold <= 16:
        raise ValueError("pHash threshold must be between 0 and 16")
    groups = []
    if asset.sha256:
        copies = list(
            (
                await session.scalars(
                    select(Asset)
                    .where(
                        Asset.sha256 == asset.sha256,
                        Asset.id != asset.id,
                    )
                    .order_by(Asset.id)
                    .limit(1000)
                )
            ).all()
        )
        if copies:
            groups.append(
                str(
                    await _persist_group(
                        session,
                        f"sha256:{asset.sha256}",
                        "exact",
                        [(item, 1.0) for item in [asset, *copies]],
                        1,
                    )
                )
            )
    if not asset.phash:
        return {"groups": groups}
    # Equal pHash retrieves resized/recompressed candidate copies using its B-tree.
    candidates = list(
        (
            await session.scalars(
                select(Asset)
                .where(
                    Asset.phash == asset.phash,
                    Asset.id != asset.id,
                )
                .order_by(Asset.id)
                .limit(200)
            )
        ).all()
    )
    if asset.captured_at:
        # Time-bounded candidates use the capture cursor index, never load the library.
        candidates.extend(
            (
                await session.scalars(
                    select(Asset)
                    .where(
                        Asset.captured_at >= asset.captured_at - timedelta(seconds=5),
                        Asset.captured_at <= asset.captured_at + timedelta(seconds=5),
                        Asset.id != asset.id,
                        Asset.phash.is_not(None),
                    )
                    .order_by(Asset.captured_at, Asset.id)
                    .limit(200)
                )
            ).all()
        )
    unique = {candidate.id: candidate for candidate in candidates}
    for candidate in unique.values():
        if candidate.sha256 == asset.sha256 or not candidate.phash:
            continue
        distance = hash_distance(asset.phash, candidate.phash)
        if distance > threshold:
            continue
        pair = sorted((str(asset.id), str(candidate.id)))
        kind = "recompressed_or_resized" if distance == 0 else "near"
        groups.append(
            str(
                await _persist_group(
                    session,
                    f"phash:{pair[0]}:{pair[1]}",
                    kind,
                    [(asset, 1), (candidate, 1 - distance / 64)],
                    threshold,
                )
            )
        )
    return {
        "groups": groups,
        "candidate_limit": 400,
        "phash_threshold": threshold,
        "coverage": "equal_phash_and_5_second_bursts; not_all_crops_or_edits",
    }

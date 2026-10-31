"""Safe application preferences persisted independently from deployment secrets."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from photointel.config import Settings, get_settings
from photointel.models import Setting
from photointel.schemas import SettingsPatch


ICLOUD_SETUP_KEYS = frozenset({"icloud_account", "icloud_library"})


async def effective_settings(session: AsyncSession) -> Settings:
    updates = {
        row.key: row.value
        for row in (
            await session.scalars(
                select(Setting).where(
                    Setting.key.in_(set(SettingsPatch.model_fields) | ICLOUD_SETUP_KEYS)
                )
            )
        ).all()
    }
    # Validate again, including production/auth/inference safety invariants.
    return Settings.model_validate({**get_settings().model_dump(), **updates})


"""Ownership, adoption and non-destructive plan contracts for Media Terraform."""
import copy
import subprocess
import unittest
from unittest.mock import patch

from infra.terraform import media_release as media
from infra.terraform import dispatch_media as dispatch


class MediaTerraformTests(unittest.TestCase):
    def test_dispatch_waits_for_its_own_terraform_run(self):
        environment = {
            "GITHUB_REPOSITORY": "rodkisten/photointel", "GITHUB_SHA": "d" * 40,
            "GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "2", "IMAGE_SHA": "b" * 40,
            "MEDIA_ACTION": "jobs-deploy",
        }
        run = {"id": 123, "display_title": "TF · apply · gcp · media-42-2", "html_url": "https://github.com/rodkisten/photointel/actions/runs/123"}
        with patch.dict(dispatch.os.environ, environment, clear=True), patch.object(dispatch, "gh", side_effect=[
            None, {"workflow_runs": [run]}, {**run, "status": "completed", "conclusion": "success"},
        ]) as gh, patch.object(dispatch.time, "sleep"):
            dispatch.main()
        payload = gh.call_args_list[0].kwargs["payload"]
        self.assertEqual(payload["inputs"]["image_sha"], "b" * 40)
        self.assertEqual(payload["inputs"]["expected_sha"], "d" * 40)
        self.assertEqual(payload["inputs"]["authorize_apply"], "true")

    def test_unrelated_apply_preserves_release_in_remote_state(self):
        outputs = {"media_release": {"value": {"source_sha": "b" * 40, "bucket": "existing-bucket"}}}
        self.assertEqual(media.release_settings(outputs, "", ""), {
            "media_image_sha": "b" * 40, "media_bucket": "existing-bucket", "media_image_digests": {}, "enable_media_jobs": True,
        })
        self.assertEqual(media.release_settings(outputs, "c" * 40, "configured-bucket")["media_image_sha"], "c" * 40)
        outputs["media_release"]["value"]["images"] = {"image": "saved-image-digest", "video": "saved-video-digest"}
        self.assertEqual(media.release_settings(outputs, "", "")["media_image_digests"], outputs["media_release"]["value"]["images"])
        self.assertEqual(media.release_settings(outputs, "c" * 40, "")["media_image_digests"], {})
        with self.assertRaises(ValueError):
            media.release_settings(outputs, "latest", "")

    def test_adoption_imports_only_existing_unmanaged_jobs(self):
        job = {"spec": {"template": {"spec": {"template": {"spec": {"containers": [{"env": [{"name": "R2_BUCKET", "value": "photointel"}]}]}}}}}}
        jobs = {"image": job, "video": None}
        imports = media.adoption_imports([], jobs, "photointel", "us-central1")
        self.assertEqual(imports, [{"to": 'google_cloud_run_v2_job.media["image"]', "id": "projects/photointel/locations/us-central1/jobs/photointel-media-image"}])
        self.assertEqual(media.adoption_imports([imports[0]["to"]], jobs, "photointel", "us-central1"), [])
        with self.assertRaisesRegex(RuntimeError, "disappeared"):
            media.adoption_imports(['google_cloud_run_v2_job.media["video"]'], jobs, "photointel", "us-central1")
        custom = copy.deepcopy(job)
        custom["spec"]["template"]["spec"]["template"]["spec"]["containers"][0]["args"] = ["custom"]
        with self.assertRaisesRegex(RuntimeError, "custom execution"):
            media.adoption_imports([], {"image": custom}, "photointel", "us-central1")

    def test_inventory_denial_is_not_permission_to_recreate(self):
        with patch.object(media, "cloud_run", return_value=subprocess.CompletedProcess([], 1, "", "PERMISSION_DENIED")):
            with self.assertRaisesRegex(RuntimeError, "Cannot inventory"):
                media.describe("image", "photointel", "us-central1")
        with patch.object(media, "cloud_run", return_value=subprocess.CompletedProcess([], 1, "", "NOT_FOUND")):
            self.assertIsNone(media.describe("image", "photointel", "us-central1"))

    def test_plan_blocks_deletion_and_both_replacement_orders(self):
        for actions in (["delete"], ["delete", "create"], ["create", "delete"]):
            with self.subTest(actions=actions), self.assertRaisesRegex(RuntimeError, "blocked"):
                media.review_plan({"resource_changes": [{"address": "existing", "change": {"actions": actions}}]})
        plan = {"resource_changes": [{"address": "media", "mode": "managed", "change": {"actions": ["update"]}}]}
        self.assertEqual(media.review_plan(plan), ["media: update"])


if __name__ == "__main__":
    unittest.main()

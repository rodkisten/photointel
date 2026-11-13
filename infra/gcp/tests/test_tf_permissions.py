"""Offline guardrails for the independent Terraform IAM workflow."""
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


class TerraformPermissionsTests(unittest.TestCase):
    def test_dataset_grant_is_scoped_and_additive(self):
        source = (ROOT / "infra/terraform/environments/permissions/main.tf").read_text()
        self.assertIn('resource "google_bigquery_dataset_iam_member"', source)
        self.assertIn('dataset_id = "custos"', source)
        self.assertIn('role       = "roles/bigquery.dataOwner"', source)
        self.assertIn("photointel-deployer@photointel.iam.gserviceaccount.com", source)
        self.assertNotIn('google_project_iam_binding', source)
        self.assertNotIn('google_bigquery_dataset_iam_policy', source)

    def test_bootstrap_wif_allowlists_permissions_workflow(self):
        bootstrap = (ROOT / "infra/gcp/bootstrap.sh").read_text()
        self.assertIn(
            "rodkisten/photointel/.github/workflows/tf-permissions.yml@refs/heads/main",
            bootstrap,
        )

    def test_workflow_uses_separate_state_and_requires_approval(self):
        source = (ROOT / ".github/workflows/tf-permissions.yml").read_text()
        self.assertIn("photointel/permissions", source)
        self.assertIn("photointel-bootstrap@photointel.iam.gserviceaccount.com", source)
        self.assertIn('if: inputs.mode == \'apply\'', source)
        self.assertIn('AUTHORIZED', source)
        self.assertIn('terraform apply -input=false -no-color permissions.tfplan', source)


if __name__ == "__main__":
    unittest.main()

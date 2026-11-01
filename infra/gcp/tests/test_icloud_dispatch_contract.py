"""Offline deployment contract for bootstrapping an iCloud queue without Scheduler.

The GCP check runner intentionally installs no backend dependencies, so this
contract verifies the versioned Python source with the standard library only.
The executable behavior is additionally covered by tests/test_dispatch_wakeups.py.
"""

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
OPERATIONS = ROOT / "apps/api/src/photointel/routers/operations.py"
RUNNER = ROOT / "apps/api/src/photointel/services/task_runner.py"


class ICloudDispatchContractTests(unittest.TestCase):
    def test_request_wakes_existing_and_new_import_after_commit(self) -> None:
        source = OPERATIONS.read_text(encoding="utf-8")
        module = ast.parse(source)
        start = next(
            item for item in module.body
            if isinstance(item, ast.AsyncFunctionDef)
            and item.name == "start_ingestion"
        )
        params = {arg.arg for arg in start.args.args}
        self.assertIn("background_tasks", params)
        calls = [
            item for item in ast.walk(start)
            if isinstance(item, ast.Call)
            and isinstance(item.func, ast.Name)
            and item.func.id == "_schedule_cloud_dispatch"
        ]
        # There is one wakeup for existing queued work and one for a new batch.
        self.assertEqual(len(calls), 2)
        wake = next(
            item for item in module.body
            if isinstance(item, ast.FunctionDef)
            and item.name == "_schedule_cloud_dispatch"
        )
        self.assertIn("background_tasks.add_task", ast.unparse(wake))
        self.assertIn("platform == 'cloud_run'", ast.unparse(wake))

    def test_already_queued_import_reuses_authorization_after_new_release(self) -> None:
        source = OPERATIONS.read_text(encoding="utf-8")
        start = source.index("async def start_ingestion(")
        end = source.index("async def set_ingestion_pause(", start)
        handler = source[start:end]
        self.assertLess(handler.index("if existing:"), handler.index("await require_import_gates("))
        self.assertLess(
            handler.index('return {"job_id": existing'),
            handler.index("await require_import_gates("),
        )
        self.assertLess(handler.index("await require_import_gates("), handler.index("batch = JobBatch("))

    def test_finite_discovery_wakes_worker_without_scheduler_or_gpu(self) -> None:
        source = RUNNER.read_text(encoding="utf-8")
        module = ast.parse(source)
        wake = next(
            item for item in module.body
            if isinstance(item, ast.AsyncFunctionDef)
            and item.name == "dispatch_ready_worker_followup"
        )
        code = ast.unparse(wake)
        self.assertIn("'worker'", code)
        self.assertIn("enqueue_dispatch", code)
        self.assertIn("drain_outbox", code)
        self.assertIn("Job.scheduled_at <= utcnow()", code)
        self.assertNotIn("scheduler", code.lower().split("if mode not in")[1])
        run = next(
            item for item in module.body
            if isinstance(item, ast.AsyncFunctionDef) and item.name == "run_finite"
        )
        self.assertIn("await dispatch_ready_worker_followup(", ast.unparse(run))


if __name__ == "__main__":
    unittest.main()

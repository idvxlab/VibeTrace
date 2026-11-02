import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

temp = tempfile.TemporaryDirectory(prefix="vibetrace-worker-errors-")
os.environ["VIBETRACE_DATA_DIR"] = temp.name
os.environ["VIBETRACE_PLUGIN_MODE"] = "1"
spec = importlib.util.spec_from_file_location("worker_error_tests", Path(__file__).resolve().parents[1] / "memory_worker/server.py")
worker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = worker
spec.loader.exec_module(worker)
MESSAGE = "This version of OpenCode Desktop no longer supports free models."
ERROR = {"name": "APIError", "data": {"message": MESSAGE}}


class WorkerErrors(unittest.TestCase):
    def test_saved_model_change_applies_to_next_internal_task(self):
        config = Path(temp.name) / "model-config.json"
        config.write_text(json.dumps({"backgroundModel": "provider/first"}), encoding="utf-8")
        with patch.dict(os.environ, {
            "VIBETRACE_MODEL_CONFIG_FILE": str(config),
            "VIBETRACE_MODEL_BACKGROUND_OVERRIDE": "",
            "VIBETRACE_MODEL_SKILL_OVERRIDE": "",
        }):
            worker.refresh_saved_model_settings()
            self.assertEqual(worker.MW_DEFAULT_MODEL_REF, "provider/first")
            config.write_text(json.dumps({"backgroundModel": "provider/second", "skillEvolutionModel": "provider/skill"}), encoding="utf-8")
            worker.refresh_saved_model_settings()
            self.assertEqual(worker.MW_DEFAULT_MODEL_REF, "provider/second")
            from skill_evolve.config import Config
            self.assertEqual(Config.load().get("opencode.model"), "provider/skill")

    def test_successful_http_response_can_contain_a_model_failure(self):
        with patch.object(worker, "opencode_request", return_value=(200, json.dumps({"info": {"error": ERROR}}))):
            with self.assertRaisesRegex(RuntimeError, MESSAGE):
                worker.opencode_send_message("internal", "test")

    def test_async_message_error_does_not_turn_into_timeout(self):
        messages = [{"info": {"id": "assistant", "role": "assistant", "error": ERROR}, "parts": []}]
        with patch.object(worker, "opencode_get_messages", return_value=messages), patch.object(worker.time, "sleep") as sleep:
            with self.assertRaisesRegex(RuntimeError, MESSAGE):
                worker.wait_assistant_stop_message("internal", set())
            sleep.assert_not_called()

    def test_diagnosis_fails_once_and_failed_result_is_cached(self):
        primary = {"session": {"id": "chat"}, "turn": {"endAssistantMessageId": "stop"}, "subtasks": [{"index": 0, "subtaskId": "panel"}]}
        with patch.object(worker, "_trace_primary_payload", return_value=primary), \
             patch.object(worker, "is_mw_internal_session", return_value=False), \
             patch.object(worker, "_error_actions_for_subtask", return_value=[]), \
             patch.object(worker, "_error_diagnosis_signature", return_value=("hash", "signature")), \
             patch.object(worker, "_error_diagnosis_run_dir", return_value=Path(temp.name) / "run"), \
             patch.object(worker, "_compact_trace_for_error_diagnosis", return_value={}), \
             patch.object(worker, "_render_error_diagnosis_prompt", return_value="test"), \
             patch.object(worker, "opencode_generate_text", side_effect=RuntimeError(MESSAGE)) as generate:
            first = worker.run_error_diagnosis_for_trace({})
            self.assertEqual(first["items"][0]["status"], "failed")
            self.assertEqual(first["items"][0]["error"], MESSAGE)
            self.assertEqual(generate.call_args.kwargs["max_attempts"], 1)
            self.assertFalse(generate.call_args.kwargs["retry_with_new_session"])
            worker.run_error_diagnosis_for_trace({})
            self.assertEqual(generate.call_count, 1)


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        temp.cleanup()

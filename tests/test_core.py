import concurrent.futures
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]


class CoreRecoveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build_dir = tempfile.TemporaryDirectory()
        cls.binary = Path(cls.build_dir.name) / "core"
        subprocess.run(["cobc", "-x", "-free", "-Wall", "-o", str(cls.binary),
                        str(ROOT / "legacy/cobol/core.cob")], check=True)
        cls.legacy_binary = Path(cls.build_dir.name) / "legacy-v1"
        subprocess.run(["cobc","-x","-free","-Wall","-o",str(cls.legacy_binary),
                        str(ROOT / "tests/fixtures/legacy-v1.cob")],check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build_dir.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.env = {**os.environ, "CORE_ROOT": str(self.directory / "core"),
                    "CORE_BINARY": str(self.binary)}

    def tearDown(self):
        self.temp.cleanup()

    def run_core(self, reference, amount=25000, mode="POST", fault=None,
                 target="EMP000000001", currency="ZAR"):
        path = self.directory / (uuid.uuid4().hex + ".dat")
        path.write_text(f"{reference}INS000000001{target}{amount:012d}{currency}\n")
        command = ["python3", str(ROOT / "legacy/core-runner.py"), mode, str(path)]
        if fault:
            command.extend(["--fault", fault])
        completed = subprocess.run(command, env=self.env, capture_output=True, text=True)
        if fault:
            self.assertNotEqual(completed.returncode, 0)
            return None
        self.assertEqual(completed.returncode, 0, completed.stderr)
        return json.loads(completed.stdout)

    def test_post_duplicate_and_conflicting_reuse(self):
        ref = str(uuid.uuid4())
        first = self.run_core(ref)
        again = self.run_core(ref)
        self.assertEqual(first["balances"], again["balances"])
        self.assertEqual(again["records"][0]["status"], "POSTED")
        conflict = self.run_core(ref, amount=50000)
        self.assertEqual(conflict["records"][0]["status"], "CONFLICT")
        self.assertEqual(first["balances"], conflict["balances"])
        original = self.run_core(ref, mode="QUERY")
        self.assertEqual(original["records"][0]["amountMinor"], 25000)

    def test_failure_before_commit_is_recoverable(self):
        ref = str(uuid.uuid4())
        self.run_core(ref, fault="before-commit")
        self.assertEqual(self.run_core(ref, mode="QUERY")["records"][0]["status"], "NOTFOUND")
        self.assertEqual(self.run_core(ref)["balances"][0]["amountMinor"], 25000)

    def test_lost_response_after_commit_does_not_double_debit(self):
        ref = str(uuid.uuid4())
        self.run_core(ref, fault="after-commit")
        query = self.run_core(ref, mode="QUERY")
        self.assertEqual(query["records"][0]["status"], "POSTED")
        self.assertEqual(query["balances"], self.run_core(ref)["balances"])

    def test_declines_and_conservation(self):
        for amount, target, currency, reason in [
            (0, "EMP000000001", "ZAR", "INVALID_REQUEST"),
            (1, "EMP999999999", "ZAR", "TARGET_UNKNOWN"),
            (1, "EMP000000003", "ZAR", "TARGET_SUSPENDED"),
            (1, "EMP000000001", "USD", "INVALID_REQUEST"),
            (5000001, "EMP000000001", "ZAR", "PER_TRANSFER_LIMIT"),
            (10000001, "EMP000000001", "ZAR", "INSUFFICIENT_FUNDS")]:
            with self.subTest(reason=reason):
                result = self.run_core(str(uuid.uuid4()), amount, target=target, currency=currency)
                self.assertEqual(result["records"][0]["reason"], reason)
                self.assertEqual(sum(x["amountMinor"] for x in result["balances"]), 10000000)

    def test_parallel_replay_posts_once(self):
        ref = str(uuid.uuid4())
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: self.run_core(ref), range(4)))
        self.assertTrue(all(r["balances"] == results[0]["balances"] for r in results))

    def test_audit_and_snapshot_are_read_only_and_expose_all_committed_outcomes(self):
        posted, declined = str(uuid.uuid4()), str(uuid.uuid4())
        self.run_core(posted)
        self.run_core(declined, target="EMP000000003")
        current = self.directory / "core/current"
        before = current.resolve()
        def read(mode):
            return json.loads(subprocess.check_output(["python3",str(ROOT / "legacy/core-runner.py"),mode],env=self.env,text=True))
        audit = read("AUDIT")
        snapshot = read("SNAPSHOT")
        self.assertEqual({r["reference"] for r in audit["records"]}, {posted,declined})
        self.assertFalse(audit["truncated"])
        self.assertEqual(snapshot["generation"],before.name)
        self.assertEqual(snapshot["balances"],audit["balances"])
        self.assertEqual(current.resolve(),before)
        self.assertEqual(next(a for a in snapshot["balances"] if a["account"]=="EMP000000003")["state"],"SUSPENDED")

    def test_v1_indexed_files_upgrade_without_resetting_balances_or_journal(self):
        core = self.directory / "core"
        old = core / "gen-v1"
        old.mkdir(parents=True)
        subprocess.run([str(self.legacy_binary)],cwd=old,env=self.env,check=True)
        (old / "manifest.json").write_text(json.dumps({"mode":"SEED","result":{"balances":[]}}))
        (core / "current").symlink_to(old.name)
        snapshot=json.loads(subprocess.check_output(["python3",str(ROOT / "legacy/core-runner.py"),"SNAPSHOT"],env=self.env,text=True))
        amounts={a["account"]:a["amountMinor"] for a in snapshot["balances"]}
        self.assertEqual(amounts,{"INS000000001":9975000,"EMP000000001":25000,"EMP000000002":0,"EMP000000003":0})
        self.assertGreater(snapshot["sequence"],0)
        ref="00000000-0000-4000-8000-000000000001"
        query=self.run_core(ref,mode="QUERY")
        self.assertEqual(query["records"][0]["status"],"POSTED")
        self.assertEqual(query["balances"],self.run_core(ref)["balances"])


if __name__ == "__main__":
    unittest.main()

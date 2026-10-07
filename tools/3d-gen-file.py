# -*- coding: utf-8 -*-
"""buddy-cloud.py 3d 命令的文件版包装：--image-base64 走 argv 会被 Windows
32KB 命令行上限截断，这里直接 import 模块、从文件读 base64 再提交。
用法： echo -n <token> | python 3d-gen-file.py <image> [--prompt "..."] [--face-count N]
输出： 与 buddy-cloud.py 相同的 JSON（含轮询等待）。
"""
import importlib.util
import base64
import json
import sys
import os

SCRIPT = ("C:/Users/lenovo/AppData/Local/Programs/WorkBuddy/resources/"
          "app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/"
          "buddy-multimodal-generation/scripts/buddy-cloud.py")

def main():
    token = sys.stdin.read().strip()
    args = [a for a in sys.argv[1:]]
    image_path = args[0]
    prompt = ""
    face_count = 30000
    if "--prompt" in args:
        i = args.index("--prompt")
        prompt = args[i + 1]
    if "--face-count" in args:
        i = args.index("--face-count")
        face_count = int(args[i + 1])

    spec = importlib.util.spec_from_file_location("buddy_cloud", SCRIPT)
    bc = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bc)
    bc._ACTIVE_TOKEN = token

    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()

    endpoint = bc._resolve_default_endpoint()
    body = bc._build_3d_body(
        prompt=prompt, model="3.1", image_base64=b64,
        face_count=face_count,
    )
    cfg = bc._PROVIDER_MAP["3d"]
    print("[INFO] submitting 3d job from %s (%d KB b64)" % (image_path, len(b64) // 1024), file=sys.stderr)
    resp = bc._call_api(endpoint, cfg["provider"], cfg["service"], cfg["version"],
                        cfg["submit_action"], body, token)
    job_id = resp.get("JobId")
    if not job_id:
        print(json.dumps({"error": "NO_JOB_ID", "raw": resp}, ensure_ascii=False))
        return 2
    print("[INFO] job: %s" % job_id, file=sys.stderr)
    result = bc._poll_job(endpoint, cfg["provider"], cfg["service"], cfg["version"],
                          cfg["query_action"], job_id, token, 5, 600)
    out = bc._format_output(result, job_id=job_id)
    bc._safe_print_json(out)
    return 0

if __name__ == "__main__":
    sys.exit(main())

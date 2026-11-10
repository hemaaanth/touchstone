import json
import os
import pathlib
import subprocess
import boto3

endpoint = os.environ["AWS_ENDPOINT_URL"]
if not endpoint.startswith("http://172.") and not endpoint.startswith("http://10.") and not endpoint.startswith("http://192.168."):
    raise ValueError("Only the private Docker lab endpoint is allowed")
s3 = boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1")
seed = json.loads(pathlib.Path("/work/seed.json").read_text())
bucket = seed["bucket"]
create = {"Bucket": bucket, "ACL": seed["acl"]}
if seed["objectLock"]:
    create["ObjectLockEnabledForBucket"] = True
s3.create_bucket(**create)
s3.put_public_access_block(Bucket=bucket, PublicAccessBlockConfiguration=seed["publicAccessBlock"])
s3.put_bucket_acl(Bucket=bucket, ACL=seed["acl"])
s3.put_bucket_versioning(Bucket=bucket, VersioningConfiguration={"Status": seed["versioning"]})
s3.put_object(Bucket=bucket, Key="index.html", Body=b"Throwaway moto frontend")
try:
    object_lock = s3.get_object_lock_configuration(Bucket=bucket).get("ObjectLockConfiguration", {}).get("ObjectLockEnabled") == "Enabled"
except s3.exceptions.ClientError:
    object_lock = False
live = {"versioning": s3.get_bucket_versioning(Bucket=bucket).get("Status"), "objectLock": object_lock, "publicWriteAcl": any(g.get("Grantee", {}).get("URI", "").endswith("/AllUsers") and g.get("Permission") in ["WRITE", "FULL_CONTROL"] for g in s3.get_bucket_acl(Bucket=bucket)["Grants"])}
checks = ["s3_bucket_public_write_acl", "s3_bucket_object_versioning", "s3_bucket_object_lock"]
result = subprocess.run([
    "/home/prowler/.venv/bin/prowler", "aws", "--region", "us-east-1", "--checks", *checks,
    "--aws-retries-max-attempts", "0", "--aws-connect-timeout", "1", "--aws-read-timeout", "1",
    "--output-formats", "json-ocsf", "--output-directory", "/work/reports", "--output-filename", "posture", "--no-banner",
], capture_output=True, text=True, timeout=120)
reports = list(pathlib.Path("/work/reports").glob("*.json"))
rows = []
for report in reports:
    data = json.loads(report.read_text())
    for finding in data if isinstance(data, list) else []:
        identity = str(finding.get("metadata", {}).get("event_code", "")) + " " + str(finding.get("finding_info", {}).get("uid", ""))
        check = next((check for check in checks if check in identity), None)
        rows.append({"check": check, "status": finding.get("status_code")})
print(json.dumps({"code": result.returncode, "findings": rows, "liveConfig": live}))

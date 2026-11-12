import { LineCounter, parseAllDocuments } from "yaml";
import { computeAddress } from "ethers";
import { redactSecret } from "../../lib/proof-evidence.mjs";

const list = (v) => v == null ? [] : Array.isArray(v) ? v : [v];
const first = (v) => Array.isArray(v) ? v[0] : v;
const namespace = (r) => r.data.metadata?.namespace ?? "default";
const actionMatches = (patterns, action) => list(patterns).some((p) => typeof p === "string" && new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i").test(action));
function policy(value) { try { return typeof value === "string" ? JSON.parse(value) : value; } catch { return null; } }
const statements = (value) => list(policy(value)?.Statement);
const broadPrincipal = (p) => p === "*" || list(p?.AWS).includes("*");
function allowed(statements, action, principal = false) {
  if (statements.some((s) => s.Effect === "Deny" && actionMatches(s.Action, action))) return [];
  return statements.filter((s) => s.Effect === "Allow" && !s.Condition && !s.NotAction && !s.NotPrincipal && actionMatches(s.Action, action) && (!principal || broadPrincipal(s.Principal)));
}

export function parseResources(snapshot) {
  const resources = [], coverage = [];
  for (const [file, source] of Object.entries(snapshot.files)) {
    if (!/\.(?:ya?ml|json)$/.test(file)) continue;
    if (source.includes("{{")) { coverage.push({ file, status: "template-only", detail: "Rendered by upstream scanners, not by crypto detectors." }); continue; }
    const lc = new LineCounter();
    const docs = parseAllDocuments(source, { lineCounter: lc, uniqueKeys: true, maxAliasCount: 100 });
    for (const [document, doc] of docs.entries()) {
      if (doc.errors.length) { coverage.push({ file, document, status: "parse-error" }); continue; }
      let data;
      try { data = doc.toJS({ maxAliasCount: 100 }); } catch { coverage.push({ file, document, status: "parse-error" }); continue; }
      if (!data || typeof data !== "object") continue;
      const add = (type, name, value, path) => resources.push({ type, name, data: value, path, file, document,
        line: (sub = []) => { let node; try { node = doc.getIn([...path, ...sub], true); } catch {} return lc.linePos(node?.range?.[0] ?? doc.getIn(path, true)?.range?.[0] ?? 0).line; },
        endLine: () => lc.linePos(doc.getIn(path, true)?.range?.[1] ?? source.length).line });
      if (data.resource) for (const [type, named] of Object.entries(data.resource)) for (const [name, value] of Object.entries(named ?? {})) add(type, name, value, ["resource", type, name]);
      else if (data.Resources) for (const [name, value] of Object.entries(data.Resources)) add(value.Type, name, value.Properties ?? {}, ["Resources", name, "Properties"]);
      else if (data.kind && data.metadata?.name) add(data.kind, data.metadata.name, data, []);
      coverage.push({ file, document, status: "parsed" });
    }
  }
  return { resources, coverage };
}

function role(r, word) {
  const tags = Array.isArray(r.data.Tags) ? Object.fromEntries(r.data.Tags.map((t) => [t.Key, t.Value])) : r.data.tags;
  const label = tags?.["touchstone-role"] ?? r.data.metadata?.labels?.["touchstone-role"];
  return label === word || new RegExp(`(^|[-_])${word}([-_]|$)`, "i").test(r.name);
}
// A reference to another resource: a CloudFormation Ref, or a Terraform
// interpolation or bare expression that reads one of its attributes.
function reference(value, resource) {
  if (typeof value === "object" && value?.Ref === resource.name) return true;
  return ["id", "arn", "name"].some((attribute) => [value, ...list(value)].includes(`${resource.type}.${resource.name}.${attribute}`) || value === `\${${resource.type}.${resource.name}.${attribute}}`);
}
const awsTypes = (r, tf, cfn) => r.type === tf || r.type === cfn;
const podSpec = (r) => r.type === "Pod" ? r.data.spec : r.type === "CronJob" ? r.data.spec?.jobTemplate?.spec?.template?.spec : r.data.spec?.template?.spec;
const podLabels = (r) => r.type === "Pod" ? r.data.metadata?.labels : r.type === "CronJob" ? r.data.spec?.jobTemplate?.spec?.template?.metadata?.labels : r.data.spec?.template?.metadata?.labels;
const workloadTypes = new Set(["Pod", "Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"]);
const isSigner = (r) => role(r, "signer") || role(r, "validator") || list(podSpec(r)?.containers).some((c) => /(?:web3signer|tmkms|validator)/i.test(c.image ?? ""));
const publicLB = (r) => r.type === "Service" && r.data.spec?.type === "LoadBalancer" && !Object.entries(r.data.metadata?.annotations ?? {}).some(([k, v]) => /internal|load-balancer-scheme/i.test(k) && /^(?:true|internal)$/i.test(String(v))) && (!r.data.spec.loadBalancerSourceRanges?.length || r.data.spec.loadBalancerSourceRanges.some((s) => ["0.0.0.0/0", "::/0"].includes(s)));
const selects = (service, workload) => namespace(service) === namespace(workload) && Object.keys(service.data.spec?.selector ?? {}).length > 0 && Object.entries(service.data.spec.selector).every(([k, v]) => podLabels(workload)?.[k] === v);
const argValue = (args, flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`${flag}=`))?.slice(flag.length + 1); };
// The role a policy document is attached to, or undefined when it is not tied to a role.
export function attachedRole(r, rs) {
  if (r.type === "aws_iam_role_policy") {
    // `${aws_iam_role.x.name}`, `${...id}` and the bare `aws_iam_role.x.name`.
    const name = typeof r.data.role === "string" ? r.data.role.match(/^\$?\{?aws_iam_role\.([^.}]+)\./) : null;
    return rs.find((x) => x.type === "aws_iam_role" && (x.name === name?.[1] || reference(r.data.role, x)));
  }
  if (r.type === "AWS::IAM::Policy") return rs.find((x) => x.type === "AWS::IAM::Role" && list(r.data.Roles).some((v) => reference(v, x)));
}
// A trust policy that lets any principal assume the role.
const wildcardTrust = (role) => statements(role.data.assume_role_policy_document ?? role.data.AssumeRolePolicyDocument)
  .some((s) => s.Effect === "Allow" && broadPrincipal(s.Principal) && actionMatches(s.Action, "sts:AssumeRole"));
// Allow statements that read objects in every bucket.
const wildcardObjectRead = (r) => allowed(statements(r.data.policy ?? r.data.PolicyDocument), "s3:GetObject")
  .filter((s) => list(s.Resource).some((v) => /^(\*|arn:aws:s3:::\*(\/\*)?)$/.test(v)));

export function analyze(snapshot) {
  const { resources: rs, coverage } = parseResources(snapshot), leads = [];
  const add = (check, r, path, description, impact = "High", extra = {}) => {
    const line = r.line(path), resource = `${r.type}.${r.name}`;
    leads.push({ engine: "Touchstone", check, impact, file: r.file, lines: [line], resource,
      where: { file: r.file, line, document: r.document, resource, ...(extra.secret ? { secretHash: extra.secret.sha256 } : {}) },
      description, ...extra });
  };
  const buckets = rs.filter((r) => awsTypes(r, "aws_s3_bucket", "AWS::S3::Bucket") && role(r, "frontend"));
  for (const r of rs) {
    if (awsTypes(r, "aws_kms_key", "AWS::KMS::Key") && allowed(statements(r.data.policy ?? r.data.KeyPolicy), "kms:Sign", true).some((s) => list(s.Resource).includes("*"))) {
      add("broad-kms-sign", r, [r.type === "aws_kms_key" ? "policy" : "KeyPolicy"], "A key-policy Allow gives the wildcard principal kms:Sign without a restricting condition. The key can authorize signing. This does not prove a deployed key or a usable transaction signature. Fix: restrict the principal and signing conditions.");
    }
    if (awsTypes(r, "aws_instance", "AWS::EC2::Instance") && isSigner(r)) {
      const publicIP = r.data.associate_public_ip_address === true || list(r.data.NetworkInterfaces).some((n) => n.AssociatePublicIpAddress === true);
      const groups = list(r.data.vpc_security_group_ids ?? r.data.SecurityGroupIds);
      const exposed = rs.filter((g) => awsTypes(g, "aws_security_group", "AWS::EC2::SecurityGroup") && groups.some((v) => reference(v, g))).filter((g) => list(g.data.ingress ?? g.data.SecurityGroupIngress).some((i) => list(i.cidr_blocks ?? i.CidrIp).includes("0.0.0.0/0")));
      if (publicIP && exposed.length) add("internet-signer-security-group", r, [r.type === "aws_instance" ? "vpc_security_group_ids" : "SecurityGroupIds"], "A public-address signer instance references a security group with world ingress. This declares network exposure, not a deployed route or a successful signing request. Fix: remove public ingress and use a private signer network.", "High", { related: exposed.map((g) => ({ file: g.file, line: g.line(), resource: `${g.type}.${g.name}` })) });
    }
    if (awsTypes(r, "aws_lb", "AWS::ElasticLoadBalancingV2::LoadBalancer") && isSigner(r) && (r.data.internal === false || r.data.Scheme === "internet-facing")) {
      const listener = rs.find((l) => awsTypes(l, "aws_lb_listener", "AWS::ElasticLoadBalancingV2::Listener") && reference(l.data.load_balancer_arn ?? l.data.LoadBalancerArn, r));
      if (listener) add("public-signer-load-balancer", r, [r.type === "aws_lb" ? "internal" : "Scheme"], "A signer or validator load balancer is internet-facing and has a listener. Backend reachability and authentication are not tested. Fix: keep the signing endpoint private.");
    }
    if (r.type === "Service") {
      const selected = rs.filter((w) => workloadTypes.has(w.type) && selects(r, w));
      if ((r.data.spec?.type === "NodePort" || publicLB(r)) && selected.some(isSigner)) add("exposed-signer-service", r, ["spec", "type"], `A Service selects a signer workload and uses ${r.data.spec.type}. NodePort alone does not prove internet routing. A public LoadBalancer requests external exposure. Fix: use a private ClusterIP service and restrict ingress.`);
      if (publicLB(r)) for (const w of selected) for (const c of list(podSpec(w)?.containers)) {
        const args = [...list(c.command), ...list(c.args)];
        const apis = argValue(args, "--http.api")?.split(",").filter((a) => ["admin", "debug", "personal"].includes(a));
        const port = Number(argValue(args, "--http.port") ?? 8545);
        const mapped = list(r.data.spec.ports).some((p) => Number(p.targetPort ?? p.port) === port);
        if (args.includes("--http") && argValue(args, "--http.addr") === "0.0.0.0" && apis?.length && mapped) add("internet-rpc-admin-namespaces", r, ["spec", "ports"], "A public LoadBalancer maps to an RPC listener on all interfaces with admin, debug, or personal namespaces enabled. This is a configured path, not a live RPC test. Fix: remove administrative namespaces from public RPC.", "High", { related: [{ file: w.file, line: w.line(), resource: `${w.type}.${w.name}` }], namespaces: apis });
      }
    }
    if (r.type === "ConfigMap") for (const [name, value] of Object.entries(r.data.data ?? {})) {
      if (/(?:hot.?wallet|private.?key|deployer.?key)/i.test(name) && /^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) {
        try { const address = computeAddress(value.startsWith("0x") ? value : `0x${value}`); add("hot-wallet-key-in-config", r, ["data", name], "A ConfigMap stores an EVM private key in plain text. ConfigMaps are not a secret store. No balance or live use is checked. Fix: use an isolated signing service and rotate the exposed key.", "High", { secret: redactSecret(value), address }); } catch {}
      }
    }
    const envs = workloadTypes.has(r.type) ? list(podSpec(r)?.containers).flatMap((c) => list(c.env)) : r.type === "aws_ecs_task_definition" ? list(policy(r.data.container_definitions)).flatMap((c) => list(c.environment)) : r.type === "AWS::ECS::TaskDefinition" ? list(r.data.ContainerDefinitions).flatMap((c) => list(c.Environment)) : [];
    for (const env of envs) {
      const name = env.name ?? env.Name, value = env.value ?? env.Value;
      if (/(?:hot.?wallet|private.?key|deployer.?key)/i.test(name ?? "") && /^(?:0x)?[a-f0-9]{64}$/i.test(value ?? "")) {
        try { add("hot-wallet-key-in-env", r, [], "A workload environment embeds an EVM private key. Anyone able to read its task or pod configuration can recover it. No live use is checked. Fix: remove the literal and rotate the key.", "High", { secret: redactSecret(value), address: computeAddress(value.startsWith("0x") ? value : `0x${value}`) }); } catch {}
      }
    }
    if (r.type === "RoleBinding" && rs.some((w) => workloadTypes.has(w.type) && isSigner(w) && namespace(w) === namespace(r))) {
      const subjects = list(r.data.subjects).filter((s) => s.kind === "ServiceAccount" && /(?:^|[-_])ci(?:[-_]|$)/i.test(s.name));
      const bound = rs.find((p) => p.name === r.data.roleRef?.name && p.type === r.data.roleRef?.kind && (p.type === "ClusterRole" || namespace(p) === namespace(r)));
      const exec = bound && list(bound.data.rules).some((rule) => list(rule.apiGroups).some((v) => ["", "*"].includes(v)) && !list(rule.resourceNames).length && list(rule.resources).some((v) => ["*", "pods/exec"].includes(v)) && list(rule.verbs).some((v) => ["*", "create"].includes(v)));
      if (subjects.length && exec) add("ci-can-exec-signers", r, ["subjects"], "A CI service account is bound to a role that can create pods/exec requests in a namespace containing a signer. This is declared RBAC access, not proof that a token was stolen. Fix: remove exec permission and separate deploy access from signing workloads.");
    }
  }
  for (const b of buckets) {
    const tf = b.type === "aws_s3_bucket", props = b.data;
    const companion = (type) => rs.find((r) => r.type === type && reference(r.data.bucket, b));
    const version = tf ? first(companion("aws_s3_bucket_versioning")?.data.versioning_configuration)?.status ?? first(props.versioning)?.enabled : props.VersioningConfiguration?.Status;
    if ([undefined, false, "Suspended", "Disabled"].includes(version)) add("frontend-versioning-disabled", b, [], "The front-end bucket has no enabled versioning configuration in this snapshot. Overwritten assets may lack a prior version to restore. Fix: enable versioning on this bucket.", "Medium");
    else if (version !== "Enabled" && version !== true) coverage.push({ file: b.file, status: "unresolved", property: "bucket versioning" });
    const lock = tf ? props.object_lock_enabled ?? companion("aws_s3_bucket_object_lock_configuration")?.data.object_lock_enabled : props.ObjectLockEnabled;
    if (lock === undefined || lock === false || lock === "Disabled") add("frontend-object-lock-missing", b, [], "The front-end bucket does not enable Object Lock in this snapshot. Retention and recovery controls need review. This is not proof of a live bucket setting. Fix: enable an appropriate immutable retention policy.", "Medium");
    else if (lock !== true && lock !== "Enabled") coverage.push({ file: b.file, status: "unresolved", property: "bucket Object Lock" });
    const block = tf ? companion("aws_s3_bucket_public_access_block")?.data ?? {} : props.PublicAccessBlockConfiguration ?? {};
    const acl = props.acl ?? props.AccessControl;
    if (["public-read-write", "PublicReadWrite"].includes(acl) && block.ignore_public_acls !== true && block.block_public_acls !== true && block.IgnorePublicAcls !== true && block.BlockPublicAcls !== true) add("frontend-public-write", b, [tf ? "acl" : "AccessControl"], "The front-end bucket requests a public-write ACL without a blocking public-ACL configuration. An applied policy can let strangers replace front-end assets. Fix: remove public-write and enable public-access blocks.");
    const bucketName = props.bucket ?? props.BucketName;
    for (const r of rs.filter((r) => ["aws_iam_role_policy", "AWS::IAM::Policy"].includes(r.type) && (role(r, "ci") || /(?:^|[-_])ci(?:[-_]|$)/i.test(r.data.role ?? "")))) {
      const grants = allowed(statements(r.data.policy ?? r.data.PolicyDocument), "s3:PutObject");
      if (grants.some((s) => list(s.Resource).some((v) => v === "*" || v === `arn:aws:s3:::${bucketName}/*` || v === `\${${b.type}.${b.name}.arn}/*`))) add("ci-can-write-frontend", r, [r.type === "aws_iam_role_policy" ? "policy" : "PolicyDocument"], "A CI role policy grants PutObject on the front-end bucket. Compromised CI can replace assets under this declared grant. This is a trust-boundary warning, not proof of a compromised token. Fix: restrict and isolate release publishing.", "Medium", { related: [{ file: b.file, line: b.line(), resource: `${b.type}.${b.name}` }] });
    }
  }
  for (const p of rs.filter((r) => r.type === "aws_iam_role_policy" || r.type === "AWS::IAM::Policy")) {
    const owner = attachedRole(p, rs);
    if (!owner || !wildcardTrust(owner) || !wildcardObjectRead(p).length) continue;
    add("iam-role-broad-object-read", p, [p.type === "aws_iam_role_policy" ? "policy" : "PolicyDocument"], "An assumable role trusts every principal and can read objects in every bucket. Any holder of the assumed credential reads data outside its own workload. The pinned source alone does not show the read. The live moto replay assumes the role and reads an unrelated bucket. Fix: limit the trust, the actions and the bucket pattern.", "High", { related: [{ file: owner.file, line: owner.line(), resource: `${owner.type}.${owner.name}` }], role: `${owner.type}.${owner.name}` });
  }
  return { leads, coverage };
}

const CHECKS = ["broad-kms-sign", "internet-signer-security-group", "public-signer-load-balancer", "exposed-signer-service", "internet-rpc-admin-namespaces", "hot-wallet-key-in-config", "hot-wallet-key-in-env", "ci-can-exec-signers", "iam-role-broad-object-read", "frontend-versioning-disabled", "frontend-object-lock-missing", "frontend-public-write", "ci-can-write-frontend"];
export function cryptoDetectors() {
  const cache = new WeakMap();
  return Object.fromEntries(CHECKS.map((check) => [check, (snapshot, where) => {
    if (!cache.has(snapshot)) cache.set(snapshot, analyze(snapshot));
    return { ok: cache.get(snapshot).leads.some((l) => l.check === check && JSON.stringify(l.where) === JSON.stringify(where)) };
  }]));
}

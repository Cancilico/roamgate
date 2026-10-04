import {
  readFileSync,
  openSync,
  closeSync,
  constants,
  fstatSync,
} from "node:fs";
import { dataRoot } from "../config/data-paths";
import { join } from "node:path";
import { roamgateEnv } from "../config/environment";

type Backend = {
  url: string;
  token_env?: string;
  token_file?: string;
  host_id: string;
};
type Json = Record<string, unknown>;
type Agent = {
  agent?: string;
  agent_session?: string | { value?: string; id?: string };
  pane_id?: string;
  terminal_id?: string;
  agent_status?: string | { state?: string };
};

function record(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid coordination response");
  return value as Json;
}

export function readCoordinationBackend(connectionId: string): Backend | null {
  let contents: string;
  try {
    contents = readFileSync(
      roamgateEnv("COORDINATION_CONFIG") ??
        join(dataRoot(), "coordination.json"),
      "utf8",
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Could not read coordination configuration", { cause: e });
  }
  if (contents.length > 65536)
    throw new Error("Coordination configuration is too large");
  const entry = record(JSON.parse(contents))[connectionId];
  if (!entry) return null;
  const config = record(entry);
  if (
    typeof config.url !== "string" ||
    !(
      (typeof config.token_env === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(config.token_env) &&
        config.token_file === undefined) ||
      (typeof config.token_file === "string" &&
        config.token_file.startsWith("/") &&
        config.token_env === undefined)
    ) ||
    typeof config.host_id !== "string" ||
    !config.host_id
  )
    throw new Error("Invalid coordination configuration");
  const url = new URL(config.url);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    !(
      url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
    )
  )
    throw new Error("Coordination requires HTTPS or a loopback URL");
  return {
    url: url.origin,
    token_env: config.token_env as string | undefined,
    token_file: config.token_file as string | undefined,
    host_id: config.host_id,
  };
}

export function createCoordinationHandler({
  connectionId,
  herdrCall,
  isCurrent,
  backend = readCoordinationBackend,
  fetchImpl = fetch,
}: {
  connectionId: string;
  herdrCall: (method: string, params?: Json) => Promise<unknown>;
  isCurrent: () => boolean;
  backend?: (id: string) => Backend | null;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  return async (method: string, params: Json = {}): Promise<unknown> => {
    const config = backend(connectionId);
    if (!config) {
      if (method === "coordination.snapshot") return { enabled: false };
      throw new Error("Coordination is not configured for this connection");
    }
    let token = config.token_env ? process.env[config.token_env] : undefined;
    if (config.token_file) {
      let fd;
      try {
        fd = openSync(
          config.token_file,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const info = fstatSync(fd);
        if (!info.isFile() || info.mode & 0o077 || info.size > 1024)
          throw new Error("Invalid token file");
        token = readFileSync(fd, "utf8").trim();
      } catch {
        throw new Error("Coordination credentials are unavailable");
      } finally {
        if (fd !== undefined) closeSync(fd);
      }
    }
    if (!token) throw new Error("Coordination credentials are unavailable");
    const request = async (path: string, body?: Json): Promise<Json> => {
      if (!isCurrent())
        throw new Error("Connection changed; refresh before retrying");
      let response: Response;
      try {
        response = await fetchImpl(`${config.url}/coordination/v1/${path}`, {
          method: body ? "PUT" : "GET",
          redirect: "error",
          headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(10000),
        });
      } catch {
        throw new Error("Coordination backend unavailable");
      }
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "Queue item changed or delivery is uncertain; refresh and check the session"
            : "Coordination request failed",
        );
      if (Number(response.headers.get("content-length")) > 8 * 1024 * 1024)
        throw new Error("Coordination response is too large");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Empty coordination response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 8 * 1024 * 1024)
            throw new Error("Coordination response is too large");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel();
      }
      const result = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!isCurrent())
        throw new Error("Connection changed; refresh before retrying");
      if (result.hostId !== config.host_id)
        throw new Error(
          "Coordination backend host does not match this connection",
        );
      return result;
    };
    const snapshot = async () => {
      const value = await request("snapshot");
      if (
        value.version !== 1 ||
        !Array.isArray(value.items) ||
        !Array.isArray(record(value.fleet).sessions)
      )
        throw new Error("Unsupported coordination backend");
      return value;
    };
    if (method === "coordination.snapshot")
      return { enabled: true, ...(await snapshot()) };
    if (
      typeof params.id !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(params.id) ||
      !Number.isSafeInteger(params.expected_version)
    )
      throw new Error("Invalid queue item request");
    const path = `items/${encodeURIComponent(params.id)}`;
    if (method === "coordination.update") {
      if (
        ![
          "answer",
          "complete",
          "dismiss",
          "reopen",
          "delivery_result",
        ].includes(String(params.action))
      )
        throw new Error("Unsupported queue action");
      return request(path, params);
    }
    if (method !== "coordination.send")
      throw new Error("Unknown coordination method");
    const value = await snapshot();
    const item = (value.items as Json[]).find((i) => i.id === params.id);
    if (!item || item.source === "native")
      throw new Error("Open the original session to answer this request");
    if (!record(value.fleet).fresh)
      throw new Error("Refresh the fleet before sending a reply");
    const peer = (record(value.fleet).sessions as Json[]).find(
      (s) => s.sessionKey === item.sessionKey,
    );
    if (!peer?.paneId)
      throw new Error("The originating session is no longer available");
    const verify = async () => {
      if (!isCurrent())
        throw new Error("Connection changed; reply was not sent");
      const roster = record(await herdrCall("agent.list"));
      const agent = (Array.isArray(roster.agents) ? roster.agents : []).find(
        (a: Agent) => a.pane_id === peer.paneId,
      ) as Agent | undefined;
      const id =
        typeof agent?.agent_session === "string"
          ? agent.agent_session
          : agent?.agent_session?.value || agent?.agent_session?.id;
      const status =
        typeof agent?.agent_status === "string"
          ? agent.agent_status
          : agent?.agent_status?.state;
      if (
        !isCurrent() ||
        !agent ||
        id !== item.sessionId ||
        agent.agent !== item.provider ||
        (peer.terminalId && agent.terminal_id !== peer.terminalId)
      )
        throw new Error("The originating session changed; reply was not sent");
      if (!["idle", "done"].includes(status || ""))
        throw new Error(
          "Open the original session or wait until the agent is idle",
        );
    };
    await verify();
    const claimed = await request(path, {
      action: "prepare_delivery",
      expected_version: params.expected_version,
      ...(params.answer === undefined ? {} : { answer: params.answer }),
    });
    const delivery = record(claimed.delivery);
    let status = "failed";
    try {
      await verify();
      status = "unknown";
      await herdrCall("agent.prompt", {
        target: peer.paneId,
        text: `Response to needs-you item ${item.id}:\n${claimed.answer || "The user marked this handoff done. Continue when appropriate."}`,
      });
      status = "sent";
    } finally {
      await request(path, {
        action: "delivery_result",
        expected_version: claimed.version,
        attempt_id: delivery.attemptId,
        result: status,
      });
    }
    return { status };
  };
}

export type QueueItem = {
  id: string;
  sessionKey: string;
  sessionId: string;
  provider: string;
  kind: string;
  ask: string;
  howTo: string;
  cwd: string;
  repository: string | null;
  source: string;
  status: string;
  answer: string | null;
  version: number;
  createdAt: string;
  delivery: { status: string; attemptId: string } | null;
};
export type FleetSession = {
  sessionKey: string | null;
  sessionId: string | null;
  provider: string;
  paneId: string | null;
  name: string;
  task: string | null;
  cwd: string;
  checkout: string | null;
  repository: string | null;
  branch: string | null;
  status: string;
  sharedCheckout: boolean;
  observedAt: string | null;
};
export type CoordinationSnapshot = {
  enabled: boolean;
  items: QueueItem[];
  fleet: {
    fresh: boolean;
    sessions: FleetSession[];
    generatedAt: string | null;
  };
};

export function parseCoordinationSnapshot(
  value: unknown,
): CoordinationSnapshot {
  const data = value as CoordinationSnapshot & { version?: number };
  if (data?.enabled === false)
    return {
      enabled: false,
      items: [],
      fleet: { fresh: false, sessions: [], generatedAt: null },
    };
  if (
    data?.enabled !== true ||
    data.version !== 1 ||
    !Array.isArray(data.items) ||
    data.items.length > 500 ||
    !Array.isArray(data.fleet?.sessions) ||
    data.fleet.sessions.length > 200 ||
    typeof data.fleet.fresh !== "boolean"
  )
    throw new Error("Invalid coordination snapshot");
  for (const item of data.items) {
    if (
      !item ||
      ![
        item.id,
        item.sessionKey,
        item.sessionId,
        item.provider,
        item.kind,
        item.ask,
        item.howTo,
        item.cwd,
        item.status,
        item.source,
        item.createdAt,
      ].every((v) => typeof v === "string") ||
      !Number.isSafeInteger(item.version) ||
      item.version < 1 ||
      (item.answer !== null && typeof item.answer !== "string") ||
      (item.delivery !== null &&
        (!item.delivery ||
          typeof item.delivery.status !== "string" ||
          typeof item.delivery.attemptId !== "string"))
    )
      throw new Error("Invalid queue item");
  }
  for (const session of data.fleet.sessions) {
    if (
      !session ||
      ![session.provider, session.name, session.cwd, session.status].every(
        (v) => typeof v === "string",
      ) ||
      ![
        session.sessionKey,
        session.sessionId,
        session.paneId,
        session.repository,
        session.branch,
        session.task,
        session.checkout,
        session.observedAt,
      ].every((v) => v === null || typeof v === "string") ||
      typeof session.sharedCheckout !== "boolean"
    )
      throw new Error("Invalid fleet session");
  }
  return data;
}

export function queueItemOpen(item: QueueItem): boolean {
  return (
    ["pending", "answered"].includes(item.status) ||
    (item.status === "resolved" &&
      item.source !== "native" &&
      item.delivery?.status !== "sent")
  );
}

export function canSendQueueItem(
  item: QueueItem,
  fleet: CoordinationSnapshot["fleet"],
): boolean {
  const session = fleet.sessions.find((s) => s.sessionKey === item.sessionKey);
  return (
    item.source !== "native" &&
    fleet.fresh &&
    !!session?.paneId &&
    ["idle", "done"].includes(session.status) &&
    !["sent", "sending", "unknown"].includes(item.delivery?.status || "")
  );
}

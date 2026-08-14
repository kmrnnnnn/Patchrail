type SafeLogFields = {
  requestId?: string;
  workspaceId?: string;
  repositoryId?: string;
  runId?: string;
  stage?: string;
  model?: string;
  tokens?: number;
  cost?: number;
  duration?: number;
  prNumber?: number;
  workerId?: string;
  errorCode?: string;
  [key: string]: string | number | boolean | null | undefined;
};

function write(level: "info" | "warn" | "error", event: string, fields: SafeLogFields = {}) {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...safeFields,
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, fields?: SafeLogFields) => write("info", event, fields),
  warn: (event: string, fields?: SafeLogFields) => write("warn", event, fields),
  error: (event: string, fields?: SafeLogFields) => write("error", event, fields),
};

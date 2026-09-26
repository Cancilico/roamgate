/** UI requests are independent of workspace state; never persist file contents. */
export interface FileEditorRequest {
  path?: string;
  base?: string;
  edit?: boolean;
  newFile?: boolean;
  connectionId?: string;
}
let requests: ((request: FileEditorRequest) => void) | undefined;
let queued: FileEditorRequest | undefined;
export function openHostFile(request: FileEditorRequest = {}) {
  if (requests) requests(request);
  else queued = request;
}
export function subscribeFileEditorRequests(
  handler: (request: FileEditorRequest) => void,
) {
  requests = handler;
  if (queued) {
    const request = queued;
    queued = undefined;
    handler(request);
  }
  return () => {
    if (requests === handler) requests = undefined;
  };
}
let guard: ((next: () => void) => boolean) | undefined;
export function registerFileEditorGuard(value: (next: () => void) => boolean) {
  guard = value;
  return () => {
    if (guard === value) guard = undefined;
  };
}
export function guardFileEditorNavigation(next: () => void) {
  return guard?.(next) ?? true;
}

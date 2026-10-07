import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { useConnectionClient } from "../useConnectionClient";
import type { BrowserVoice, VoiceState } from "../browserVoice";
import "./VoiceControl.css";

export function VoiceControl({
  paneId,
  codex,
}: {
  paneId?: string | null;
  codex: boolean;
}) {
  const client = useConnectionClient();
  const [available, setAvailable] = useState(false);
  const [state, setState] = useState<VoiceState>({
    status: "idle",
    name: "Codex",
    muted: false,
    message: "",
    playbackBlocked: false,
    transcript: [],
  });
  const controller = useRef<BrowserVoice | null>(null);
  useEffect(() => {
    let mounted = true;
    setAvailable(false);
    let voice: BrowserVoice | null = null;
    void client
      .call("voice.capabilities")
      .then(async (result) => {
        if (
          !mounted ||
          !client.isCurrent() ||
          result?.available !== true ||
          !window.isSecureContext ||
          !navigator.mediaDevices?.getUserMedia
        )
          return;
        const { BrowserVoice } = await import("../browserVoice");
        if (!mounted || !client.isCurrent()) return;
        voice = new BrowserVoice(client, (next) => {
          if (mounted) setState(next);
        });
        controller.current = voice;
        voice.end();
        setAvailable(true);
      })
      .catch(() => undefined);
    const end = () => voice?.end();
    window.addEventListener("pagehide", end);
    const hidden = () => {
      if (document.hidden) voice?.end();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted = false;
      voice?.end();
      controller.current = null;
      window.removeEventListener("pagehide", end);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [client]);
  if (!available) return null;
  const active = state.status === "starting" || state.status === "connected";
  return (
    <>
      <button
        type="button"
        className="ghost"
        disabled={!active && (!paneId || !codex)}
        onClick={() => {
          if (!active && paneId) void controller.current?.start(paneId);
        }}
        title="Talk to the selected Codex agent. End Workspace Voice on this phone before starting."
      >
        <Mic size={16} /> Voice
      </button>
      {(active || state.status === "error") &&
        createPortal(
          <section
            className="voice-control"
            aria-label="Codex voice conversation"
          >
            <div className="voice-control-row">
              <strong>{state.name}</strong>
              <span role="status">
                {state.status === "starting"
                  ? "Connecting"
                  : state.status === "error"
                    ? "Voice unavailable"
                    : state.muted
                      ? "Muted"
                      : "Listening"}
              </span>
              {active && (
                <button
                  type="button"
                  onClick={() => controller.current?.mute()}
                  aria-pressed={state.muted}
                  aria-label={
                    state.muted ? "Unmute microphone" : "Mute microphone"
                  }
                >
                  {state.muted ? <MicOff size={18} /> : <Mic size={18} />}
                </button>
              )}
              <button
                type="button"
                onClick={() => controller.current?.end()}
                aria-label={
                  active ? "End voice conversation" : "Dismiss voice error"
                }
              >
                <PhoneOff size={18} />
              </button>
            </div>
            {state.message && <p role="alert">{state.message}</p>}
            {state.playbackBlocked && (
              <button
                type="button"
                onClick={() => void controller.current?.resumePlayback()}
              >
                Play voice audio
              </button>
            )}
            {state.transcript.length > 0 && (
              <details>
                <summary>Transcript</summary>
                <div className="voice-control-transcript" aria-live="polite">
                  {state.transcript.map((item) => (
                    <p key={item.id}>
                      <strong>
                        {item.role === "user" ? "You" : "Codex"}:{" "}
                      </strong>
                      {item.text}
                    </p>
                  ))}
                </div>
              </details>
            )}
          </section>,
          document.body,
        )}
    </>
  );
}

import type { ConnectionClient } from "./api";
import {
  BrowserVoiceTransport,
  type VoiceTransport,
  type VoiceEvent,
} from "./voiceTransport";

export type VoiceState = {
  status: "idle" | "starting" | "connected" | "error";
  name: string;
  muted: boolean;
  message: string;
  playbackBlocked: boolean;
  transcript: { id: string; role: string; text: string }[];
};
type Resources = {
  id: string;
  transport: VoiceTransport;
  peer: RTCPeerConnection;
  audio: HTMLAudioElement;
  stream?: MediaStream;
  cancelled: boolean;
  timer?: ReturnType<typeof setTimeout>;
};
export class BrowserVoice {
  private resources: Resources | null = null;
  private state: VoiceState = {
    status: "idle",
    name: "Codex",
    muted: false,
    message: "",
    playbackBlocked: false,
    transcript: [],
  };
  constructor(
    private readonly client: ConnectionClient,
    private readonly changed: (state: VoiceState) => void,
    private readonly environment = {
      microphone: () =>
        navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
      peer: () => new RTCPeerConnection(),
      audio: () => new Audio(),
      transport: (event: (event: VoiceEvent) => void): VoiceTransport =>
        new BrowserVoiceTransport(client, event),
    },
  ) {}

  private update(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    this.changed(this.state);
  }
  private event(resources: Resources, event: VoiceEvent) {
    if (
      resources.cancelled ||
      this.resources !== resources ||
      (event.call_id && event.call_id !== resources.id)
    )
      return;
    if (event.status === "ended" || event.status === "error") {
      this.release(resources);
      this.update({
        status: event.status === "error" ? "error" : "idle",
        message: event.message || "",
      });
    } else if (
      event.transcript &&
      typeof event.transcript.item_id === "string"
    ) {
      const part = event.transcript;
      const transcript = [...this.state.transcript];
      const index = transcript.findIndex((item) => item.id === part.item_id);
      const previous =
        index < 0
          ? { id: part.item_id, role: "", text: "" }
          : transcript[index];
      const next = {
        ...previous,
        role: part.role ?? previous.role,
        text: (part.text ?? previous.text + (part.delta ?? "")).slice(-16000),
      };
      if (index < 0) transcript.push(next);
      else transcript[index] = next;
      this.update({ transcript: transcript.slice(-20) });
    }
  }

  async start(paneId: string) {
    if (this.resources) return;
    const peer = this.environment.peer();
    const audio = this.environment.audio();
    audio.autoplay = true;
    const resources: Resources = {
      id: crypto.randomUUID(),
      peer,
      audio,
      cancelled: false,
      transport: this.environment.transport((event) =>
        this.event(resources, event),
      ),
    };
    this.resources = resources;
    this.update({
      status: "starting",
      name: "Codex",
      message: "",
      muted: false,
      transcript: [],
      playbackBlocked: false,
    });
    const check = () => {
      if (resources.cancelled || !this.client.isCurrent())
        throw new Error("Voice start cancelled");
    };
    resources.timer = setTimeout(() => {
      if (!resources.cancelled) {
        this.release(resources);
        this.update({ status: "error", message: "Voice connection timed out" });
      }
    }, 45000);
    peer.ontrack = (event) => {
      if (resources.cancelled) return;
      audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void audio.play().catch(() => {
        if (!resources.cancelled) this.update({ playbackBlocked: true });
      });
    };
    peer.onconnectionstatechange = () => {
      if (resources.cancelled) return;
      if (peer.connectionState === "connected") {
        clearTimeout(resources.timer);
        this.update({ status: "connected" });
      }
      if (["failed", "disconnected", "closed"].includes(peer.connectionState)) {
        this.release(resources);
        this.update({
          status: "error",
          message: "Voice connection lost. Start again to reconnect.",
        });
      }
    };
    try {
      const stream = await this.environment.microphone();
      if (resources.cancelled) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      resources.stream = stream;
      check();
      stream.getAudioTracks().forEach((track) => {
        track.enabled = !this.state.muted;
        peer.addTrack(track, stream);
        track.onended = () => {
          if (!resources.cancelled) {
            this.release(resources);
            this.update({
              status: "error",
              message: "Microphone disconnected",
            });
          }
        };
      });
      peer.createDataChannel("oai-events");
      await peer.setLocalDescription(await peer.createOffer());
      check();
      await resources.transport.connect();
      check();
      const result = await resources.transport.call("voice.start", {
        pane_id: paneId,
        call_id: resources.id,
        sdp: peer.localDescription?.sdp,
      });
      check();
      this.update({ name: result.name });
      await peer.setRemoteDescription({ type: "answer", sdp: result.sdp });
      check();
    } catch (error) {
      if (resources.cancelled) return;
      this.release(resources);
      this.update({
        status: "error",
        message: error instanceof Error ? error.message : "Voice failed",
      });
    }
  }

  mute() {
    const resources = this.resources;
    if (!resources || resources.cancelled) return;
    const muted = !this.state.muted;
    resources.stream?.getAudioTracks().forEach((track) => {
      track.enabled = !muted;
    });
    this.update({ muted });
  }
  async resumePlayback() {
    const resources = this.resources;
    if (!resources) return;
    try {
      await resources.audio.play();
      if (!resources.cancelled) this.update({ playbackBlocked: false });
    } catch {
      /* Keep the explicit playback control available. */
    }
  }
  private release(resources: Resources) {
    if (resources.cancelled) return;
    resources.cancelled = true;
    clearTimeout(resources.timer);
    resources.stream?.getTracks().forEach((track) => track.stop());
    resources.peer.ontrack = null;
    resources.peer.onconnectionstatechange = null;
    resources.peer.close();
    resources.audio.pause();
    resources.audio.srcObject = null;
    // Closing the dedicated socket is the authoritative server-side cleanup,
    // including pending starts and changes to the main UI connection lease.
    resources.transport.close();
    if (this.resources === resources) this.resources = null;
  }
  end() {
    if (this.resources) this.release(this.resources);
    this.update({ status: "idle", muted: false, playbackBlocked: false });
  }
}

import { expect, test } from "bun:test";
import { BrowserVoice, type VoiceState } from "./browserVoice";
import type { ConnectionClient } from "./api";
import type { VoiceEvent } from "./voiceTransport";

function fixture() {
  let deliver: (event: VoiceEvent) => void = () => {};
  let resolveMic!: (value: MediaStream) => void;
  let closeCount = 0;
  let trackStops = 0;
  let peerCloses = 0;
  const states: VoiceState[] = [];
  const track = {
    enabled: true,
    stop: () => {
      trackStops++;
    },
  };
  const stream = {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  } as unknown as MediaStream;
  const peer = {
    localDescription: { sdp: "v=0" },
    connectionState: "new",
    ontrack: null,
    onconnectionstatechange: null,
    addTrack: () => {},
    createDataChannel: () => {},
    createOffer: async () => ({ type: "offer", sdp: "v=0" }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => {},
    close: () => {
      peerCloses++;
    },
  } as unknown as RTCPeerConnection;
  const client = { isCurrent: () => true } as ConnectionClient;
  const voice = new BrowserVoice(client, (state) => states.push(state), {
    microphone: () =>
      new Promise((resolve) => {
        resolveMic = resolve;
      }),
    peer: () => peer,
    audio: () =>
      ({
        autoplay: false,
        play: async () => {},
        pause: () => {},
        srcObject: null,
      }) as unknown as HTMLAudioElement,
    transport: (event) => {
      deliver = event;
      return {
        connect: async () => {},
        close: () => {
          closeCount++;
        },
        call: async () => ({ name: "Original agent", sdp: "answer" }),
      };
    },
  });
  return {
    voice,
    states,
    peer,
    track,
    resolveMic: () => resolveMic(stream),
    deliver: (event: VoiceEvent) => deliver(event),
    counts: () => ({ closeCount, trackStops, peerCloses }),
  };
}

test("ending during microphone permission releases late-arriving tracks", async () => {
  const f = fixture();
  const starting = f.voice.start("pane");
  f.voice.end();
  f.resolveMic();
  await starting;
  expect(f.counts()).toEqual({ closeCount: 1, trackStops: 1, peerCloses: 1 });
  expect(f.states[f.states.length - 1]?.status).toBe("idle");
});

test("mute and end affect only owned media; duplicate cleanup is harmless", async () => {
  const f = fixture();
  const starting = f.voice.start("pane");
  f.resolveMic();
  await starting;
  f.voice.mute();
  expect(f.track.enabled).toBe(false);
  f.voice.mute();
  expect(f.track.enabled).toBe(true);
  f.voice.end();
  f.voice.end();
  expect(f.counts()).toEqual({ closeCount: 1, trackStops: 1, peerCloses: 1 });
});

test("bridge loss ends media without reconnecting or accepting later transcripts", async () => {
  const f = fixture();
  const starting = f.voice.start("pane");
  f.resolveMic();
  await starting;
  f.deliver({ call_id: "", status: "error", message: "Lost connection" });
  f.deliver({
    call_id: "",
    status: "connected",
    transcript: { item_id: "late", text: "ignored" },
  });
  expect(f.states[f.states.length - 1]?.status).toBe("error");
  expect(f.states[f.states.length - 1]?.transcript).toHaveLength(0);
  expect(f.counts()).toEqual({ closeCount: 1, trackStops: 1, peerCloses: 1 });
});

test("muting during microphone permission keeps late-arriving audio muted", async () => {
  const f = fixture();
  const starting = f.voice.start("pane");
  f.voice.mute();
  f.resolveMic();
  await starting;
  expect(f.track.enabled).toBe(false);
  expect(f.states[f.states.length - 1]?.muted).toBe(true);
  f.voice.end();
});

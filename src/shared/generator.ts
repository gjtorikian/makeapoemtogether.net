import type { GeneratorInput, GeneratorOutput } from "./types";

// The boundary between the room engine and the poem composer.
//
// There are two of these, and the split is deliberate:
//
// `Generator` is the original pure, synchronous, deterministic contract. The
// rule-based composer in src/engine/compose.ts implements it, and it remains the
// guaranteed fallback — it cannot fail, cannot block, and needs no network.
//
// `AsyncComposer` is what the room's transport actually calls. It is allowed to
// take seconds and to reach the network (the OpenRouter pass in
// src/engine/llm.ts), which is why composition became an *effect* rather than a
// synchronous step inside `Room.handle`. Every AsyncComposer must resolve — one
// that cannot produce a poem is expected to fall back to `Generator` rather than
// reject, so a reveal can never fail.
export interface Generator {
  compose(input: GeneratorInput): GeneratorOutput;
}

export interface AsyncComposer {
  compose(input: GeneratorInput): Promise<GeneratorOutput>;
}

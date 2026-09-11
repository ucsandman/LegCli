// Pipeline presets. A station is { name, kind, chain?, prompt? }; kinds are
// agent | human | test | land. `chain` on an agent station defaults to the
// card's chain when omitted (src/pipeline.mjs applies it). The v1 limit
// handoff runs inside any agent station; `factory` is where v2 is headed.
export const PRESETS = {
  factory: [
    { name: 'plan', kind: 'agent', prompt: 'plan' },
    { name: 'build', kind: 'agent', prompt: 'build' },
    { name: 'review', kind: 'agent', prompt: 'review' },
    { name: 'test', kind: 'test' },
    { name: 'land', kind: 'land' },
  ],
  build: [
    { name: 'build', kind: 'agent', prompt: 'build' },
  ],
  'build-land': [
    { name: 'build', kind: 'agent', prompt: 'build' },
    { name: 'test', kind: 'test' },
    { name: 'land', kind: 'land' },
  ],
}

export const PRESET_NAMES = Object.keys(PRESETS)

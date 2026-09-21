# Playground documents

Laid out as every repository of the organization is
([`.github/CONTRIBUTING.md`](https://github.com/sabiruby/.github/blob/main/CONTRIBUTING.md)).
The playground's own design document lives with the VM, since the wasm module is a thin skin
over it: [sabiruby/docs/design/playground.md](https://github.com/sabiruby/sabiruby/blob/main/docs/design/playground.md)
(the C ABI, the debugger, real-time `sleep`).

| file | language | what it is |
|---|---|---|
| [ideas.md](ideas.md) | English | what the playground can show because the VM is SabiRuby; which of the ideas are done |
| [plans/visualizer-plan.md](plans/visualizer-plan.md) | Japanese | the instructions the VM inspector (ideas 1–6) was built from; done 2026-09-12 |
| [worklog/2026-09-18-highlight.md](worklog/2026-09-18-highlight.md) | Japanese | `sabi_highlight` / `sabi_take_highlight` and `sabi.js`'s `highlight()`: the editor colours of rubevy_games, stage H1 of `rubevy_games/docs/plans/editor-highlight-plan.md` |
| [worklog/2026-09-21-next-line.md](worklog/2026-09-21-next-line.md) | Japanese | the stepper follows SabiRuby's rename of `Vm::current_line` to `Vm::next_line` (no behaviour change), and **when this may go to main**: the order the three repositories have to move in, and why `SABIRUBY_REF` is bumped in the same commit |

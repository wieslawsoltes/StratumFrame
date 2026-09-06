# Stratum Frame

[**Open Stratum Frame on GitHub Pages**](https://wieslawsoltes.github.io/StratumFrame/) · [Standalone HTML](https://wieslawsoltes.github.io/StratumFrame/stratum-frame.html) · [Analysis assumptions](docs/ANALYSIS.md)

[![Verify and deploy](https://github.com/wieslawsoltes/StratumFrame/actions/workflows/pages.yml/badge.svg)](https://github.com/wieslawsoltes/StratumFrame/actions/workflows/pages.yml)

**An independent structural-frame modeling and finite-element analysis workbench.** Plain HTML, CSS and JavaScript. Native WebGPU rendering, a separately labeled Canvas 2D compatibility renderer, and real Float64 static/modal analysis in a Web Worker. No framework, CDN, runtime package or remote solver.

The workspace follows familiar ETABS-style organization: model explorer, Define/Draw/Assign/Analyze/Display menus, simultaneous 3D and plan views, object properties and result tables. It does not use CSI code, branding, proprietary file formats or a CSI analysis engine.

> This is a runnable research/verification implementation, not a complete ETABS replacement or certified structural-design package. Results must not be the sole basis for construction, approval or safety-critical decisions. Read [analysis assumptions and verification limits](docs/ANALYSIS.md).

## Run

Use Node.js 20 or newer; **no `npm install` is required**.

```sh
git clone https://github.com/wieslawsoltes/StratumFrame.git
cd StratumFrame
npm start
# Open http://localhost:8080
```

A different port works on all platforms:

```sh
node serve.mjs 8765
# Open http://localhost:8765
```

The server binds to loopback by default. For deliberate LAN serving, set `HOST=0.0.0.0`; WebGPU normally requires a secure context, so prefer localhost or HTTPS. Do not expose the development server as a hardened production server.

There is also a self-contained file: **`dist/stratum-frame.html`**. All CSS, application code, worker code and analytical benchmarks are embedded. Open it in a desktop browser. Browser policies may restrict workers, persistence or GPU access for local files; localhost is the recommended execution path. Mobile file-preview applications may display HTML without executing it.

WebGPU is feature-detected at runtime. An unavailable adapter, unsupported API or initialization failure switches to a clearly labeled Canvas compatibility renderer. Numerical calculations are unchanged. Analysis is **CPU Float64 in a worker**, not GPU compute.

## Working features

| Area | Implementation |
|---|---|
| Geometry | Stories, Cartesian grids, explicit joints, beams/columns/inclined frames, snapping, joint movement, member connection and splitting, property assignment, cascading deletion |
| Definitions | Isotropic elastic materials, arbitrary positive A/I2/I3/J sections, rectangular-section calculator, local-axis roll, six-component supports, twelve local end-release flags |
| Constraints | Exact fixed-support elimination, horizontal rigid diaphragms, independent internal released-end DOFs; no penalty springs |
| Loading | Separate load cases, self-weight factors, global joint forces/moments, local/global uniform member forces, interior member point forces, linear case combinations |
| Static analysis | Spatial Euler–Bernoulli frames, sparse CSR assembly, RCM ordering, diagonal scaling, skyline LDLᵀ, refinement and equilibrium diagnostics |
| Modal analysis | Consistent distributed mass, added joint mass/inertia, deterministic inverse subspace iteration, mass orthogonalization, Rayleigh–Ritz extraction, eigenpair residual checks and XYZ effective mass fractions |
| Results | Deformed curves, animated modes, six member-force diagrams, support forces/moments, joint displacements, story response/drift tables, analysis diagnostics |
| Project lifecycle | Atomic validated edits, bounded undo/redo, local autosave with failure reporting, validated SI JSON import/export, current-table CSV and self-contained HTML analysis report |
| Rendering | Shared WebGPU device, instanced section geometry, WGSL shading, depth buffering, 4× MSAA, batched lines, reusable GPU buffers, independent orthographic 3D/plan/elevation cameras |

### First session

The six-story example loads and analyzes automatically. Change the displayed case from `SERVICE` to `WINDX` or `LATERAL`, then choose **Deformed shape**, **Moment M2** or **Mode shape**. These are computed results, not stored animation keyframes. The deformation magnification is visual only; tables contain physical values.

Click a member in plan or 3D to edit its section and local-axis roll. Use **Assign → Joint / member loads** to enter values such as `-10 kN/m`. A model edit immediately discards stale results. **F5** recomputes every case, combination and requested mode.

**B/C/J/M** select beam/column/joint/move tools. Drawing takes place in the active plan story. Two beam clicks create endpoints or reuse coincident joints. A column connects the active story to the preceding reference story. **Shift-click** adds/removes selection; **Shift-drag** box-selects; **F** fits views. **Ctrl/Cmd+Z**, **Ctrl/Cmd+Y**, **Ctrl/Cmd+S** and **Ctrl/Cmd+O** perform undo, redo, export and import. Drag in 3D to orbit, middle/right-drag to pan, and scroll/pinch to zoom. Use **View → Plan in main view** for a larger plan. Small screens switch the main view to plan when drawing.

Adding a story row adds a reference level, not framing. Editing an existing story elevation moves joints at its former elevation. Grid edits do not relocate existing geometry. Frame intersections do not automatically create structural connectivity: use shared joint IDs and split members where a connection is intended. New joints are not silently added to diaphragms, except a split midpoint whose original endpoints share that diaphragm.

## Verification

```sh
npm test       # 40 Node tests: 32 numerical/data checks + 8 project-store tests
npm run verify # writes docs/verification-results.json with values and tolerances
npm run build  # recreates the portable HTML; no build dependencies
```

The numerical suite covers axial extension, biaxial bending, torsion, self-weight, UDL and interior point forces, fixed/fixed interior deformation, simply supported response, double-ended releases, orientation/roll, consistent mass, cantilever frequency, tip-mass-only modes, diaphragm compatibility, global equilibrium, superposition and invalid/unstable models. The 12-element cantilever fundamental frequency differs from the analytical value by approximately **4.13 × 10⁻⁷ relative** in the recorded run. This is a targeted benchmark, not an overall accuracy guarantee.

The recorded browser interaction suite contains **29 passing checks**: pointer selection, live section and load edits, invalid-unit rejection, release assignment, loaded-member splitting, result invalidation, undo/redo, worker recalculation, all result displays, animation, unit switching, file import, embedded benchmarks and compact-screen drawing. It produced no uncaught JavaScript or console errors.

**The recorded browser run used Canvas fallback. The WebGPU path is implemented but was not exercised or GPU-performance-benchmarked in this environment.** This distinction is recorded as `webgpuValidated: false` in [browser-results.json](docs/browser-results.json). Cross-browser, real-adapter and large-model validation remain outstanding. Some display modes in the browser suite are selected through the same application command API rather than native dropdown automation.

Optional browser automation requires Python and Playwright, separately from the application:

```sh
python tools/browser_smoke.py --url http://localhost:8080
# Reproduce the recorded no-navigation bundle test:
python tools/browser_smoke.py --inline --chromium /path/to/chromium
```

The editable default example has **84 joints, 174 members, 504 physical joint DOFs and 234 active unknowns**. The recorded first six frequencies are approximately **1.73662, 1.80908, 1.93274, 5.47083, 5.66766 and 6.04901 Hz**. Example loads, masses and combinations are illustrative; they are not an engineering specification.

## Source organization

```text
index.html, styles.css          Desktop-style workspace and responsive layout
src/app.js                     Editing commands, interaction, worker lifecycle, exports
src/analysis-worker.js         Revision-tagged worker protocol and transferable results
src/core/model.js              Canonical schema, validation, model templates
src/core/units.js              Dimension-checked parsing and display conversions
src/core/elements.js           Local axes, element K/M, loads and force/shape recovery
src/core/linalg.js             Sparse CSR, RCM/skyline LDLᵀ, modal eigensolver
src/core/analysis.js           DOF mapping, assembly, solution, recovery and combinations
src/ui/renderer.js             WebGPU + explicit Canvas compatibility rendering
src/ui/store.js                Transactional model/history/persistence
src/ui/dialogs.js              Definition and assignment editors, guide, benchmarks
src/ui/icons.js                Original vector UI icons
examples/                     Ready-to-open JSON projects and generated reference results
tests/                        Analytical, validation and transactional tests
tools/                        Portable build and optional browser tests
docs/                         Formulation, scope, machine-readable verification, screenshots
```

### Engine API

The same engine works in a worker, directly in a browser module, or in Node:

```js
import { createBuilding } from './src/core/model.js';
import { analyze } from './src/core/analysis.js';

const model = createBuilding({ stories: 2, baysX: 1, baysY: 1 });
const result = analyze(model, { modal: true, modes: 6 }, progress => {
  console.log(progress.stage);
});
console.log(result.static.WINDX.u);           // Float64Array, [UX,UY,UZ,RX,RY,RZ] / joint
console.log(result.static.DEAD.reactions);   // N and N·m in global axes
console.log(result.modes.map(m => m.frequency)); // Hz, only converged eigenpairs
console.log(result.warnings, result.modalError);
```

The synchronous engine throws `AnalysisError` for invalid or unstable static models. A modal failure is reported separately so already verified static solutions remain available. It never substitutes made-up frequencies or arbitrary stabilizing springs.

## Explicit scope boundaries

No shell/slab/wall stiffness, flexible diaphragms, shear-deformable beams, P–Δ, buckling, nonlinear materials, hinges, tension-only elements, rigid end offsets, prescribed settlements, spring supports, load-code generation, response spectra, time histories, staged construction, composite action, warping torsion, steel/concrete member design, ETABS file interoperability or design approval are implemented. Only undamped free-vibration modes are included. See [ANALYSIS.md](docs/ANALYSIS.md) before interpreting results.

Source is provided under the [MIT license](LICENSE). Documentation references underlying formulations and API standards in [REFERENCES.md](docs/REFERENCES.md).

## GitHub Pages deployment

The `pages.yml` workflow verifies the engine, rebuilds the standalone HTML, stages an explicit static-site allowlist, and publishes to GitHub Pages on pushes to `main`. Pull requests run verification and build only. The workflow can also be started manually from Actions.

```sh
npm run build:pages
# Static output: _site/
```

The site uses relative URLs so the application, module worker and in-app benchmarks work under `/StratumFrame/`. The deployed site includes editable examples, documentation and a standalone HTML download. No runtime services or external CDN assets are required. The workflow also tests the deployed application in Chromium, including worker analysis and the first computed modal frequency. Headless-browser validation does not establish hardware WebGPU performance.

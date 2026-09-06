# Analysis formulation, conventions and verification limits

## 1. Model and physical units

The persisted project is `schema: "stratum-frame"`, `version: 1`, `units: "SI"`. Internal geometry is metres, forces newtons, stresses pascals, mass kilograms, time seconds and rotation radians. Each physical joint has six ordered components:

```text
[UX, UY, UZ, RX, RY, RZ]
```

Support flags impose exactly zero components; prescribed nonzero motion is not supported. A member references its I and J joint IDs and an assigned prismatic section/material. Connectivity depends on identity, not visual crossings or coincident coordinates. Coincident joints and duplicate members produce warnings; duplicate members contribute stiffness and mass separately. Disconnected joints stop analysis.

`A`, `Iy`, `Iz`, `J` are independent positive input properties. `Iy = ∫z² dA`, `Iz = ∫y² dA`. Isotropic material input is E > 0, −1 < ν < 0.5 and density ≥ 0; G = E/[2(1+ν)]. Rendering width/depth do not change A/I/J unless the rectangular-section calculator is used. For a rectangle with local-y width b and local-z depth h:

```text
A = b h; Iy = b h³ / 12; Iz = h b³ / 12
J ≈ a c³ [1/3 − 0.21(c/a)(1 − c⁴/(12a⁴))]
a = max(b,h), c = min(b,h)
```

J is an engineering approximation for Saint-Venant torsion, not the polar second moment or a warping constant. More accurate user-defined properties can be entered directly.

Dimension-aware fields reject incompatible suffixes. For example, `200 GPa` converts to 200e9 Pa, whereas `3 kN` is rejected as a length. SI JSON is never silently reinterpreted as imperial storage. The display selector converts values without changing model numbers. The advanced assigned-load table explicitly uses raw SI vectors, unlike dimension-aware assignment dialogs.

## 2. Element axes and stiffness

Local x points I → J. Unless |x·globalZ| ≥ 0.95, local y is normalized(globalZ × x); near vertical it is normalized(globalY × x). Local z = x × y. Roll rotates y/z about x. This convention is explicit and is not guaranteed to match another program's automatic member axes. Use roll and force signs accordingly.

Local component ordering is:

```text
[u1I,u2I,u3I,r1I,r2I,r3I,u1J,u2J,u3J,r1J,r2J,r3J]
```

For a length L, axial and torsional two-DOF blocks use:

```text
k_axial = EA/L [ 1 −1; −1 1 ]
k_torsion = GJ/L [ 1 −1; −1 1 ]
```

The local-y bending block on `[u2I,r3I,u2J,r3J]` is EI_z/L³ times:

```text
[ 12     6L   −12     6L  ]
[  6L   4L²   −6L    2L² ]
[−12    −6L    12    −6L  ]
[  6L   2L²   −6L    4L² ]
```

Local-z bending on `[u3I,r2I,u3J,r2J]` uses EI_y and premultiplication/postmultiplication by diag(1,−1,1,−1). The sign change follows r2 = −du3/dx. These are straight, small-displacement, linear Euler–Bernoulli members. There is no shear flexibility or second-order geometric stiffness.

## 3. Consistent mass

Let m = ρAL. Axial translational mass is m/6 `[2 1; 1 2]`. The local-y bending mass on the above Hermite DOFs is m/420 times:

```text
[156    22L     54    −13L ]
[22L    4L²    13L    −3L² ]
[54     13L    156    −22L ]
[−13L  −3L²   −22L     4L²]
```

Local-z uses the same rotation-sign mapping. Torsional inertia is ρ(Iy+Iz)L/6 `[2 1; 1 2]`. Bending cross-sectional rotary inertia is not included; bending rotational DOF entries above arise from transverse Hermite interpolation. This is not a Timoshenko or Rayleigh beam formulation.

An optional scalar `node.mass` adds the same translational mass to UX/UY/UZ. Optional `node.massInertia = [Ix,Iy,Iz]` adds rotational inertia in kg·m². Element mass and added joint mass coexist. **Added joint mass does not create gravity load.** A diaphragm does not generate slab mass. Mode shapes depend on mesh resolution and the assigned mass source; consistent mass is not a substitute for convergence studies.

## 4. Supports, diaphragms and releases

For each element there is a sparse mapping B_e from independent unknowns q to its local end components. Assembly forms:

```text
K = Σ B_eᵀ k_e B_e
M = Σ B_eᵀ m_e B_e + mapped joint mass
F = Σ B_eᵀ f_e + mapped joint forces
```

Fixed joint components have empty maps. No arbitrary springs enforce restraints.

A horizontal diaphragm uses a reference point `(cx,cy)` at the arithmetic mean of its assigned joints, and three master unknowns `[Ux,Uy,Rz]`:

```text
ux(node) = Ux − (y−cy)Rz
uy(node) = Uy + (x−cx)Rz
rz(node) = Rz
```

UZ/RX/RY remain independent. Each joint may belong to at most one diaphragm. Coplanarity tolerance is 1e-6 m. A diaphragm needs distinct in-plane points. UX/UY/RZ restraints on diaphragm joints are rejected, rather than silently overconstraining the master. This is a rigid in-plane kinematic constraint, **not a slab or shell** and not a semi-rigid diaphragm.

A released element end component maps to a new independent local element DOF instead of the corresponding joint component. This keeps both stiffness and consistent mass without static-only condensation or penalty factors. The independent static DOF equilibrates to zero released end action; dynamic released-end motion retains inertia. Releases can create mechanisms. A double-ended axial/torsional release, for example, can leave an unrestrained internal rigid-body mode and is not stabilized automatically.

Exactly zero diagonal stiffness components are omitted only when they have exactly zero mass and mapped force in every case. These omissions are listed in warnings. Otherwise zero stiffness stops analysis. Nontrivial singularity is detected in factorization. Tiny transformation coefficients below 1e-14 are dropped to avoid floating-point axis noise; this is not added stiffness.

## 5. Loads and combinations

Joint loads are six global components in N/N·m. Member forces are three local or global components, either full-span uniform in N/m or concentrated strictly inside 0 < a/L < 1. Endpoint forces belong on joints. Interior concentrated moments, trapezoidal loads and partial-span UDL records are not implemented; subdivide framing for separate uniform load regions.

Consistent nodal loads are integrals of the linear axial/Hermite bending functions. Uniform local transverse loads generate signed end moments ±qL²/12. Concentrated loads evaluate shape functions at a/L. Every case may independently include material self-weight, using `−9.80665 × density × A × selfWeightFactor` in global Z.

Combination results are algebraic sums of solved cases, including displacements, recovered forces and load particulars. Nested combinations, envelopes and response-spectrum combinations are not accepted. The template's SERVICE/ULS/LATERAL factors are illustrative, not a design-code implementation. Negative user case factors are allowed.

## 6. Sparse solution and diagnostics

Assembly uses Float64 full symmetric CSR. Reverse Cuthill–McKee reorders the graph. With S_ii = 1/√K_ii, the solver factorizes the reordered S K S using a skyline LDLᵀ factor. It then solves for scaled unknowns and maps back. A single stiffness factor serves all static cases and modal inverse applications.

A nonfinite diagonal, nonpositive diagonal, or normalized factor pivot ≤ 1e-12 stops analysis, with the implicated reordered DOF label. Pivots below 1e-8 generate an ill-conditioning warning. These are numerical acceptance thresholds, **not condition-number estimates** or a proof of physical modeling correctness. Ill-conditioned yet solvable systems may still produce inaccurate responses.

Up to three iterative-refinement corrections are attempted. Static acceptance requires a finite vector and:

```text
||Kq − F||₂ / max(||F||₂, 1) ≤ 1e-7
```

The residual uses mixed force/moment generalized components in canonical SI; it is a diagnostic, not a dimension-independent physical error estimator. Global applied and support force/moment resultants about the global origin are also recovered and exposed in reports, but their norm is not an additional universal solver acceptance threshold.

Project guards allow at most 2,000 joints and 6,000 members. Skyline profile allocation is separately capped at 24 million Float64 entries (about 192 MB for the profile alone). These are guardrails, not a guarantee that every accepted model fits available memory or runs interactively. Released DOFs can enlarge the system considerably. No out-of-core or distributed solver is provided.

## 7. Eigenproblem

Undamped free vibration solves `Kφ = λMφ`, with `f = √λ/(2π)` and `T = 2π/√λ`. A deterministic starting subspace, inverse applications K⁻¹M, double M-orthogonalization and Rayleigh–Ritz projection are used. The small symmetric projected eigenproblem uses Jacobi rotations. Modes are sorted by positive eigenvalue and normalized to φᵀMφ = 1. The sign is made deterministic from the largest translational component.

Each accepted pair must satisfy:

```text
||Kφ − λMφ||₂ / (||Kφ||₂ + |λ| ||Mφ||₂) < 1e-8
```

Maximum iterations: 160. Requests: 1–24 modes. This is a lowest-mode subspace solver, not a general indefinite eigenproblem solver. Numerically dependent or massless search directions are removed. A massless frame with positive joint mass can retain finite modes; fewer modes than requested are reported explicitly. Difficult mass/stiffness scaling or nearly dependent subspaces may require fewer requested modes or mesh/mass changes. Failed or unconverged modes are not replaced with guesses. Modal errors are separate from valid static results.

XYZ effective mass is `(φᵀb_direction)²`, where b is assembled from each full element mass times a rigid translation influence vector, plus joint mass. Fractions use total modeled scalar mass as denominator, including material mass associated with restrained components. The reported percentages are not a code-specific seismic mass-sufficiency check. Torsional modes can have near-zero translational participation.

## 8. Recovery and visualization

Element resisting end forces are `k_e u_e − f_e`. Support reactions are recovered in global axes. Recovered forces at constrained diaphragm joints are internal constraint forces, not external supports. The six cut-face resultants `[N,V2,V3,T,M2,M3]` act on the positive-x face of the left segment. At I: `section(0+) = −endI`; at J: `section(L−) = +endJ`, for loads strictly inside the element. Thus signs in end-I tables intentionally differ from cut-face diagrams.

For local uniform force q and a station x, before concentrated-load terms:

```text
N  = −fI1 − q1 x
V2 = −fI2 − q2 x
V3 = −fI3 − q3 x
T  = −mI1
M2 = −mI2 − fI3 x − q3 x²/2
M3 = −mI3 + fI2 x + q2 x²/2
```

Each point force contributes only to stations on its right. Diagrams include uniform 1/20 stations and values at/just left of point-force discontinuities. The end-equilibrium benchmark checks these signs against the opposing end actions.

Static deformation is not merely a straight interpolation of joint translation. It uses cubic Hermite end kinematics **plus the fixed/fixed particular solution** for applied UDL and interior point forces, and the corresponding axial particular solution. Consequently, a fully fixed single member has a nonzero interior load deflection even with zero free joint DOFs. Modal curves use finite-element interpolation without static load particulars.

Reported maximum member displacement is **sampled at 21 stations**, combined with joint translations, not found through continuous extremum root solving. Graphical deformation is magnified automatically (or by the user); force arrows use illustrative display lengths rather than physical scale. Self-weight is included in analysis but is not shown as separate load arrows. Joint moment and support moment values are in tables; arrow glyphs show translational force vectors only. Screenshots and legends identify which renderer is in use.

Story response tables consider joints within 1e-6 m of a reference story. Adjacent-story drift is computed only for matching X/Y joint coordinates (within 1e-6 m), divided by story height. No matching pair yields a zero accumulated value; it does not establish zero building drift or compliance. There is no code limit, torsional amplification or accidental eccentricity calculation.

## 9. Editing and reproducibility

Project edits are applied to a cloned model and committed only after validation. Undo/redo restores snapshots but invalidates results; there is no stale-result reuse. The UI terminates a running worker on edit/cancel and checks both run ID and model revision before accepting a response. The portable build revokes worker Blob URLs on completion, failure and cancellation.

Splitting a member at its midpoint preserves outer-end releases and its roll/section, duplicates UDL density on the two children, remaps interior point-force positions, and turns a midpoint point force into a global joint force. New inner ends are unreleased. A midpoint inherits a shared parent-end diaphragm: this can strengthen in-plane constraint sampling and therefore change responses for models whose unsplit member previously admitted internal in-plane bending. Modal responses can change under subdivision because the mass/displacement approximation improves. The included browser check compares original-joint displacements for the default vertical-load case, not all possible split models.

Saved projects contain model definitions, not trusted results. Reopening requires a fresh solve. Autosave uses one browser-origin localStorage slot, with explicit failure notification. History is bounded to 60 snapshots and approximately 24 MB of serialized strings. Exports provide a portable project snapshot; the HTML report includes units, model revision, diagnostics and model JSON.

## 10. Coverage is finite

Passing benchmarks establishes agreement for the listed analytical cases and numerical tolerances only. It does not establish equivalence to ETABS, all possible release configurations, every singular mechanism, every ill-conditioned eigenproblem, or engineering suitability. The browser tests cover representative commands, not an exhaustive UI state space. The GPU branch has not been executed on an adapter in the recorded environment. Screenshots were made with the Canvas fallback.

Out of scope: slabs/shells/walls, flexible diaphragms, offsets/rigid links, spring supports/partial fixity, settlements, shear deformation, bending rotary inertia, P–Δ, buckling, plasticity, cracking, geometric/material nonlinearity, gap/contact, staged construction, temperature/strain loads, response spectra, time histories, damping response, code-generated wind/seismic loads, design checks, proprietary interoperability and certification. Independent engineering verification and broader numerical/browser validation are required before consequential use.

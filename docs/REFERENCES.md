# Formulation and platform references

These references provide background for the original implementation. Their inclusion does not imply endorsement, certification, identical automatic axes, or numerical equivalence to any other program.

| Reference | Relevance |
|---|---|
| [TU Delft — Euler–Bernoulli beam finite element](https://teachbooks.tudelft.nl/computational-modelling/structural_linear/euler_bernouilli.html) | Beam assumptions, Hermite interpolation, weak formulation and bending stiffness |
| [TU Delft — Finite-element beam dynamics workshop](https://teachbooks.tudelft.nl/computational-modelling/dynamics/Exercises/str_elem_dyn_workshops/Workshop_FEM_dyn_beam_sol.html) | Distributed mass, beam dynamics and comparison against analytical behavior |
| [OpenSees — Elastic beam-column element](https://opensees.github.io/OpenSeesDocumentation/user/manual/model/elements/elasticBeamColumn.html) | Elastic-frame parameterization and separation of section, transformation and mass concepts |
| [CSI ETABS — Modeling process](https://docs.csiamerica.com/help-files/etabs/Getting_Started/Modeling_Process.htm) | Reference workflow: define, draw, assign, analyze and inspect results |
| [CSI ETABS — Diaphragms](https://docs.csiamerica.com/help-files/etabs/Menus/Define/Diaphragms.htm) | Distinction between rigid and semi-rigid diaphragms; this implementation supports only horizontal rigid constraints |
| [CSI ETABS — Frame releases and partial fixity](https://docs.csiamerica.com/help-files/etabs/Menus/Assign/Frame/Frame_Releases_and_Partial_Fixity.htm) | Release terminology; this implementation uses independent internal DOFs and does not include partial-fixity springs |
| [W3C — WebGPU specification](https://www.w3.org/TR/webgpu/) | GPU device/context model, buffers, shader modules, render pipelines, command encoding, limits and secure-context exposure |

Implementation-specific formulas, sign conventions, mass handling, tolerances and unsupported features are documented in [ANALYSIS.md](ANALYSIS.md). Benchmarks are executable in `tests/benchmarks.mjs` rather than quotations or imported numerical outputs from the reference programs.

# Calibration and distance experiment v1

This bounded local Compute experiment combines weighted rigid registration, held-out residual inspection, explicit Euclidean distance and permitted walking-route length. It is a conventional numerical baseline. It does not use Ceres, GTSAM or learned-model packages at runtime.

## Reproduce

```sh
npx esbuild scripts/calibration-access.ts --bundle --platform=node --format=esm --outfile=.stamp/calibration-access.mjs
node .stamp/calibration-access.mjs
```

Optional arguments choose the evidence and exported-artifact directories; defaults are `.payload/calibration-access` and `.payload/calibration-access-artifacts`. The utility preserves the synthetic model anchors, controls, covariance, walking-length annotations, plan and layout before executing. Repeating the request inspects the saved result without fitting or routing again. Checked-in examples preserve exact input bytes and result digests.

**This is synthetic, not a surveyed building or IFC import.** No independent survey dataset has been supplied. The fixture contains explicit model anchors and a manually annotated floor plan; its fixed test clock and generated uncertainty are labelled accordingly.

Expected results (rounded for display):

| Quantity | Result |
|---|---:|
| Fitted control RMS | 0.679 mm |
| Held-out control RMS | 20.017 mm |
| Declared held-out limit | 10 mm — exceeded |
| Entrance to Office, straight line | 15 m |
| Entrance to Office, permitted walking route | 24 m via P-01, P-07, P-08 |
| Same route after closing P-07 | Disconnected |
| Straight-line distance after closure | 15 m |

The held-out error is deliberately injected. Held-out controls never enter the optimizer or covariance calculation. Passing or failing a supplied tolerance remains an analytical result; it is not independent accuracy certification. Route exploration remains available after a failed held-out check, explicitly conditional on the unvalidated alignment and declared lengths. No result authorizes canonical admission.

## Weighted registration contract

`payload.rigid-registration.v1` binds distinct source/reference frames, metres, initial rigid transform, disjoint fit/held-out control IDs, exact evidence references, full residual covariance and its explicit control order. V1 supports 3–32 fit controls and up to 32 held-out controls, within local coordinates of ±10 km.

The statistical model is **conditional on fixed source coordinates**. Observed reference-frame XYZ coordinates have a supplied, fixed, absolute Gaussian residual covariance in square metres. Uncertain source coordinates, transformation-dependent noise and general errors-in-variables estimation require a separate extension; do not silently use this contract for those models.

The solver minimizes `rᵀ Σ⁻¹ r`. It whitens residuals and Jacobians with Cholesky solves and uses column-scaled, twice-orthogonalized QR for Gauss–Newton steps, with bounded backtracking. It does not explicitly invert Σ or solve normal equations. It preserves off-diagonal correlations, including shared reference translation errors. Reordering controls also reorders covariance axes, preserving physical and serialized normalized input identity.

Rotation updates use the SO(3) exponential. Translation increments are in the reference frame, and rotation increments left-multiply the rotation without rotating the translation vector. The reported six-parameter covariance is ordered reference translation XYZ, left rotation XYZ, in metres/radians. It is a local approximation conditional on the supplied absolute noise model; residual variance is not estimated from a conveniently small fitting error. This follows the usual weighted least-squares covariance interpretation described in the [Ceres covariance documentation](https://ceres-solver.readthedocs.io/latest/nnls_covariance.html).

The implementation refuses singular/indefinite or excessively ill-conditioned residual covariance. Rank-deficient or numerically ill-conditioned control geometry produces `UNOBSERVABLE_OR_ILL_CONDITIONED`, no usable transform and no covariance. It does not report a pseudoinverse as certainty about an unconstrained direction. A scaled QR pivot below 1e-8 triggers refusal. Iterations are capped at 40; translation and rotation step tolerances are 1e-8 m/rad. `LOCAL_STATIONARY` is a local solver status, not a global optimum or an accuracy claim. No-descent and iteration-limit exits return no usable transform.

Robust losses are not enabled in v1. Outliers retain their declared Gaussian weight. A future robust method must have its own method/version and comparable held-out evaluation; see [Ceres nonlinear least squares](https://ceres-solver.readthedocs.io/latest/nnls_tutorial.html).

## Distance semantics

`payload.access-metric.v1` is a separate metric overlay bound to the exact SpatialLayout digest and local metre frame. The baseline layout remains unchanged. Each space has an explicit anchor; each passage has an explicit nonnegative walking length or a null unknown length. A supplied walking length cannot be shorter than its anchor-to-anchor Euclidean chord.

- `LOCAL_CARTESIAN_3D` measures the straight chord between declared anchors. It does not imply traversability.
- `SHORTEST_PERMITTED_NETWORK_LENGTH` uses directed Dijkstra routing through explicitly permitted passages. It minimizes metres, not hop count or travel time. The result includes space and passage IDs, and topological reachability retains its explicit root.
- Confirmed routes use known-open passages with satisfied conditions. Possible routes may also use unresolved access. Unknown access is never silently declared open.
- Unknown lengths refuse weighted paths conservatively for the entire overlay; they do not become zero, Euclidean defaults or a disconnection verdict.

The scenario changes one passage's assumed state, preserving source evidence, anchors and lengths. Euclidean distance is unchanged. The same physical graph in a different drawing location retains its topological measures; representation and execution digests need not remain identical.

Earth ellipsoid geodesics, surface-mesh paths, turn penalties, time-dependent restrictions, speed models and physical clearance tests are outside this first service. Use distinct future distance contracts for those meanings. Geographic coordinates must not be labelled local metres. Weighted graph algorithm background: [NetworkX shortest paths](https://networkx.org/documentation/stable/reference/algorithms/shortest_paths.html).

Registration covariance is not propagated into anchor/route-length uncertainty in this increment. Walking lengths are declared fixture values, not measured or extracted from polygon contact. The exported result states `uncertaintyPropagated: false` and `fieldAccuracyEstablished: false`.

## Compute/API and Claude handoff

`POST /api/compute/calibration-access` accepts `payload.calibration-access-request.v1` with request id, purpose and exact retained experiment source. `GET /api/compute/calibration-access/{requestId}` inspects a saved receipt. Existing local-mode and same-origin checks apply; backend configuration selects the evidence root. HTTP requests cannot select paths, commands, source URLs or a different numerical backend.

Every referenced evidence artifact must verify and permit DERIVE/INTERNAL processing at execution time. An immutable request reservation precedes computation; a missing completion receipt stays incomplete and cannot silently rerun. Inspection rechecks source/receipt/result identities and historical processing decisions without recomputing registration or paths. Local digests detect corruption; they do not authenticate physical truth or attest that the recorded computation was performed.

`payload.calibration-access-projection.v1` is a distinct LOCAL_ANALYSIS projection. It contains controls, separate fit/held-out residuals, local covariance interpretation, declared tolerance check, transformed anchors, both distance models, baseline/scenario paths and unresolved coverage. It is not a corpus release.

Claude can link control selection to its raw evidence and residual vector; space selection to its anchor and both distance results; and the baseline/scenario switch to saved route and reachability changes. Display the failed held-out check alongside the low fit RMS. Never convert the fit RMS into an accuracy badge. This PR supplies contracts, computation, artifacts and APIs; the linked frontend remains Claude's lane.

To perform the proposed surveyed acceptance experiment, replace the synthetic inputs with preserved building geometry, measured controls with a defensible covariance model, independent held-out controls, and supported access/route-length annotations. Keep acquisition, fitting and validation provenance separate.

# Recorded observation replay v1

The module preserves sensor observations, calibration and pose evidence, then performs bounded replay and explicitly requested comparisons. It does not estimate a fused trajectory or certify field accuracy. RTK fixed/float are GNSS receiver statuses; GNSS, IMU and wheel odometry are separate sensor categories. Communications is not a positioning modality.

## Run the two examples

```sh
npx esbuild scripts/observation-replay.ts --bundle --platform=node --format=esm --outfile=.stamp/observation-replay.mjs
node .stamp/observation-replay.mjs synthetic
node .stamp/observation-replay.mjs boreas
```

Arguments after the mode optionally select an evidence directory, output directory and (Boreas only) download directory. Default outputs live under `.payload/observation-{mode}-artifacts`. The synthetic fixture uses a fixed declared test clock and two synthetic sessions. Boreas downloads only fixed public objects and explicit byte ranges, approximately 11.1 MB total. Subsequent runs verify retained bytes and inspect the existing replay without recomputation. No data is fetched by the HTTP API.

Checked-in `examples/observations` contains the source bundle/request and saved result copies for both examples, plus the recorded download manifest. Raw recorded payloads stay in the local evidence store; the exporter preserves the exact bundle bytes. Source URLs, byte ranges, ETags and SHA-256 digests are retained in a derivation artifact and the manifest. An ETag is not treated as a content digest. Byte-range captures are explicitly partial objects; the final truncated CSV row is never parsed.

## What the examples establish

The synthetic example tests a LiDAR mounting offset, body poses from two sessions and a rectified camera observation of one declared static target. It produces a zero metric residual and zero pixel residual by construction. Injecting a camera mounting offset produces a pixel residual; perturbing the second point produces a metric residual. These are software checks, not independent calibration evidence.

The recorded example retains one camera frame, one LiDAR scan, corresponding sensor-pose rows, a bounded GNSS/INS trajectory prefix, raw IMU context and mounting/projection matrices. It uses Boreas sequence `boreas-2020-11-26-13-58`. Boreas documents asynchronous sensor timestamps and post-processed positioning with RTX corrections; the adapter does not label those poses RTK fixed. See the [dataset reference](https://github.com/utiasASRL/pyboreas/blob/master/DATA_REFERENCE.md) and [dataset license, CC BY 4.0](https://github.com/utiasASRL/pyboreas/blob/master/DATA_LICENSE.md). Dataset attribution: Keenan Burnett et al., *Boreas: A multi-season autonomous driving dataset*, IJRR 2023, DOI 10.1177/02783649231160195.

The real replay has five readings:

| Reading | Result |
|---|---|
| Camera frame | Declared capture-time pose available |
| LiDAR scan centre | Declared capture-time pose available |
| First individual LiDAR point | Pose unavailable at that exact point time; world placement refused |
| GNSS/INS context | Post-processed status retained; antenna mounting/pose interpretation unresolved |
| Raw IMU context | Raw axes retained; mounting/pose interpretation unresolved |

The selected point precedes the scan centre by about 51.76 ms. The engine does not substitute the centre pose. No static correspondence has been independently annotated, so the recorded comparison is unresolved. This slice is **one recorded session**, not a completed multi-session object-consistency benchmark. The next acceptance increment needs a second session, held-out static correspondences, independently supported uncertainty and per-point motion compensation or capture-time poses.

## Contract and conventions

`payload.observation-bundle.v1` declares:

- Exact retained artifacts with RAW, CALIBRATION, TRAJECTORY, ANNOTATION or DOCUMENTATION roles.
- World/body/sensor frame identities and definitions; metres and right-handed rigid transforms.
- Sensor identities, modality and calibration binding. A missing mounting calibration is explicitly null, never an identity transform.
- Sensor clock basis, constant offset to an explicitly named reference clock, declared uncertainty and bounded validity interval. Nanosecond timestamps are decimal strings and use BigInt arithmetic. There is no guessed GPS/UTC/leap-second conversion or implicit drift correction.
- Calibration version, exact evidence, validity, mounting transform and optional rectified pinhole intrinsics.
- Pose/session/time bindings, optional 6-by-6 covariance and optional world velocity. Covariance convention is a right-local SE(3) perturbation ordered translation xyz, rotation xyz, with metre/radian units. Symmetry and positive semidefiniteness are checked within a scale-relative numerical tolerance of 1e-12.
- Raw observation selector, processing method/version/inputs, measurement and static-association declaration. Association probabilities can remain unknown. Annotation evidence is required for an asserted static correspondence.
- GNSS solution status and nullable correction source/age. A status never supplies missing covariance or accuracy.

Transforms use column vectors: `p_world = T_world_body * T_body_sensor * p_sensor`. Rotations must be proper orthonormal matrices; reflections and unsupported units are rejected. The Boreas adapter respects the documented passive roll/pitch/yaw convention and converts supplied sensor poses back to body poses before applying a mounting transform. It avoids double-counting a lever arm already present in a sensor pose. The adapter preserves its normalization formula and source bindings in the derivation artifact.

V1 requires a supplied body pose at the exact corrected observation timestamp. It does not interpolate or extrapolate. Pixel comparisons require rectified pinhole calibration, a point in front of the camera and a declared static correspondence. Two 3D points produce a metric residual; a LiDAR point and camera pixel produce a pixel reprojection residual. No combined score mixes these units. Measurements are compared as supplied; no calibration fitting is performed during evaluation.

Pose/mount covariance and clock uncertainty are preserved. Measurement covariance and cross-correlations are not yet modeled, so propagated covariance stays null. `timingSensitivityM = speed * declaredClockUncertainty` is translation-only sensitivity, not an error bound or confidence interval. At 20 m/s and 10 ms it equals 0.2 m; lever-arm rotation and other error sources remain separate. Zero residual does not set `fieldAccuracyEstablished` true.

Bounds: 64 retained artifacts, 16 sensors/clocks, 32 calibrations, 512 poses/observations, 64 explicit comparisons and 1 MiB JSON artifacts. Unknown associations, clocks and missing pose/calibration inputs are reported; they are never filled with favourable defaults.

## Local API and Claude integration

- `POST /api/observations/replays` accepts `payload.observation-replay-request.v1`: request id, purpose, exact retained bundle source and explicit observation pairs.
- `GET /api/observations/replays/{requestId}` inspects the saved execution without rerunning replay.

Use `PAYLOAD_PRODUCTION_LOCAL=1` and the existing loopback/same-origin conventions. Set `PAYLOAD_PRODUCTION_DIR` to the chosen evidence directory. Requests never accept a filesystem root, command or source URL. Every referenced source requires an allowed DERIVE/INTERNAL decision at execution time. Inspection rechecks historical bindings and source retention; it does not confer current rights. Create-only reservations prevent silent replay of an interrupted identity.

The distinct `payload.observation-replay-projection.v1` uses `sourceKind: LOCAL_ANALYSIS`. It contains validated bundle metadata, the retained result and source/receipt digests. It does not pretend to be a corpus release. Treat text as text; source images and point clouds are evidence references, not executable markup. The proposed inspector should link each timeline reading to its raw artifact, pose, mount, clock, unknown inputs and requested residual. The Spatial Inquiry UI contract is unchanged.

The symbolic IR, provenance ledger, future factor-graph estimator and independent evaluation each retain their own role. These observation records can supply factors later; the current replay does not fit a model and then call the fit independent evidence. No Rust kernel or hardware-control changes are included.

Local content digests bind records and detect corruption; they are not authenticated signatures or proof of physical truth. The current frontend is a consumer handoff, not a completed multi-sensor viewer.

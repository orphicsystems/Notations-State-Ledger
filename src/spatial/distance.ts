import { exactFields, encodeLocalRecord } from '../data-os/local-record';
import { analyze } from './analysis';
import { digest, id, hash, reference, parseLayout, type EvidenceReference, type SpatialLayout, type AnalysisRequest } from './contracts';
export interface AccessMetric {
  schema: 'payload.access-metric.v1'; layoutDigest: string; frameId: string; units: 'm';
  evidence: EvidenceReference; classification: 'SYNTHETIC' | 'RECORDED_DECLARATION';
  anchors: { spaceId: string; pointM: [number, number, number] }[];
  passages: { passageId: string; lengthM: number | null }[];
}
export const DISTANCE_METHOD = { id: 'explicit-local-access-distance', version: '1.0.0', euclidean: 'LOCAL_CARTESIAN_3D', network: 'DIJKSTRA_DIRECTED_NONNEGATIVE_METRES', unknownAccess: 'CONFIRMED_AND_POSSIBLE', unknownLengths: 'REFUSE_WEIGHTED_PATHS', tieBreak: 'STABLE_SPACE_AND_PASSAGE_ID_ORDER' } as const;
export function parseMetric(input: unknown, sourceLayout: SpatialLayout): AccessMetric {
  const layout = parseLayout(sourceLayout), v: unknown = JSON.parse(encodeLocalRecord(input, 256 * 1024).toString('utf8'));
  exactFields(v, ['schema', 'layoutDigest', 'frameId', 'units', 'evidence', 'classification', 'anchors', 'passages']); hash(v.layoutDigest); id(v.frameId); reference(v.evidence);
  if (v.schema !== 'payload.access-metric.v1' || v.layoutDigest !== digest(layout) || v.frameId !== layout.frame.id || v.units !== 'm' || layout.frame.units !== 'm' || !['SYNTHETIC', 'RECORDED_DECLARATION'].includes(v.classification as string)) throw new Error('Metric requires an exact layout and a matching local metre frame.');
  if (!Array.isArray(v.anchors) || v.anchors.length !== layout.spaces.length || !Array.isArray(v.passages) || v.passages.length !== layout.passages.length) throw new Error('Metric must explicitly cover all spaces and passages.');
  const m = v as unknown as AccessMetric, spaces = new Set<string>(), passages = new Set<string>();
  m.anchors.forEach(a => { exactFields(a, ['spaceId', 'pointM']); id(a.spaceId); if (spaces.has(a.spaceId) || !layout.spaces.some(s => s.id === a.spaceId) || !Array.isArray(a.pointM) || a.pointM.length !== 3 || a.pointM.some(x => typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > 10000)) throw new Error('Invalid or duplicate local anchor.'); spaces.add(a.spaceId); });
  m.passages.forEach(p => {
    exactFields(p, ['passageId', 'lengthM']); id(p.passageId); const source = layout.passages.find(s => s.id === p.passageId);
    if (!source || passages.has(p.passageId) || (p.lengthM !== null && (typeof p.lengthM !== 'number' || !Number.isFinite(p.lengthM) || p.lengthM < 0 || p.lengthM > 1e6))) throw new Error('Invalid or duplicate passage length.'); passages.add(p.passageId);
    const from = m.anchors.find(a => a.spaceId === source.from)!, to = m.anchors.find(a => a.spaceId === source.to)!;
    if (p.lengthM !== null && p.lengthM + 1e-8 < Math.hypot(...from.pointM.map((x, i) => x - to.pointM[i]))) throw new Error('Walking length cannot be shorter than the anchor chord.');
  });
  m.anchors.sort((a, b) => a.spaceId < b.spaceId ? -1 : 1); m.passages.sort((a, b) => a.passageId < b.passageId ? -1 : 1); return m;
}
export function measureAccess(sourceLayout: SpatialLayout, request: AnalysisRequest, input: AccessMetric, fromId: string, toId: string) {
  id(fromId); id(toId);
  const layout = parseLayout(sourceLayout), metric = parseMetric(input, layout), topology = analyze(layout, request);
  const from = metric.anchors.find(a => a.spaceId === fromId), to = metric.anchors.find(a => a.spaceId === toId);
  if (!from || !to) throw new Error('Distance endpoints must be declared space anchors.');
  const unknownLengths = metric.passages.filter(p => p.lengthM === null).map(p => p.passageId);
  function route(possible: boolean) {
    if (unknownLengths.length) return null;
    const distance = new Map<string, number>([[fromId, 0]]), previous = new Map<string, { spaceId: string; passageId: string }>(), settled = new Set<string>();
    const edges = topology.passages.filter(p => p.effectiveState === 'OPEN' || (possible && p.effectiveState === 'UNKNOWN')).flatMap(p => {
      const lengthM = metric.passages.find(w => w.passageId === p.id)!.lengthM!;
      const edge = { from: p.from, to: p.to, passageId: p.id, lengthM }; return p.direction === 'BOTH' ? [edge, { ...edge, from: p.to, to: p.from }] : [edge];
    });
    while (true) {
      const current = layout.spaces.filter(s => !settled.has(s.id) && distance.has(s.id)).sort((a, b) => distance.get(a.id)! - distance.get(b.id)! || (a.id < b.id ? -1 : 1))[0];
      if (!current) return null; if (current.id === toId) break; settled.add(current.id);
      for (const edge of edges.filter(e => e.from === current.id)) {
        if (settled.has(edge.to)) continue;
        const candidate = distance.get(current.id)! + edge.lengthM;
        if (candidate < (distance.get(edge.to) ?? Infinity)) { distance.set(edge.to, candidate); previous.set(edge.to, { spaceId: current.id, passageId: edge.passageId }); }
      }
    }
    const spaceIds = [toId], passageIds: string[] = []; let cursor = toId;
    while (cursor !== fromId) { const step = previous.get(cursor)!; spaceIds.unshift(step.spaceId); passageIds.unshift(step.passageId); cursor = step.spaceId; }
    return { lengthM: distance.get(toId)!, spaceIds, passageIds };
  }
  const confirmed = route(false), possible = route(true);
  const payload = { schema: 'payload.access-distance-result.v1', source: request.layout, layoutDigest: topology.layoutDigest, scenarioDigest: topology.scenarioDigest, metricDigest: digest(metric), metricEvidence: metric.evidence,
    method: DISTANCE_METHOD, parameters: { fromId, toId }, frameId: metric.frameId, units: 'm', classification: metric.classification,
    euclidean: { model: 'LOCAL_CARTESIAN_3D', distanceM: Math.hypot(...from.pointM.map((x, i) => x - to.pointM[i])), anchors: [from, to] },
    network: { model: 'SHORTEST_PERMITTED_NETWORK_LENGTH', status: unknownLengths.length ? 'LENGTH_UNRESOLVED' : confirmed ? 'CONFIRMED_ROUTE' : possible ? 'POSSIBLE_ROUTE_ONLY' : 'DISCONNECTED', confirmed, possible },
    topologicalReachability: { rootSpaceId: request.rootSpaceId, spaces: topology.reachability },
    coverage: { unknownLengthPassageIds: unknownLengths, unknownAccessPassageIds: topology.coverage.unresolvedPassageIds },
    interpretation: 'DECLARED_LENGTHS_AND_ACCESS; NOT_TRAVEL_TIME_OR_EVACUATION_COMPLIANCE', uncertaintyPropagated: false, fieldAccuracyEstablished: false };
  return { ...payload, digest: digest(payload) };
}

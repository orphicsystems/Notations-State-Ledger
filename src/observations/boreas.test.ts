import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { compose, inverse, decimalSecondsNs } from './boreas';
import { apply, replay } from './replay';
import { parseBundle } from './contracts';
it('replays the recorded sample without substituting scan time for individual point time', () => {
  const bundle = parseBundle(JSON.parse(readFileSync(resolve('examples/observations/boreas-bundle.json'), 'utf8')));
  const result = replay(bundle, [{ id: 'check', leftId: 'lidar-point-0', rightId: 'camera-frame' }]);
  expect(result.coverage.aligned).toBe(2);
  expect(result.readings.find(r => r.id === 'lidar-point-0')?.reasons).toEqual(['POSE_NOT_AT_CAPTURE_TIME']);
  expect(result.readings.find(r => r.id === 'lidar-point-0')?.pointWorldM).toBeNull();
  expect(result.comparisons[0].residual).toBeNull();
  expect(result.readings.find(r => r.id === 'gnss-context')?.gnss?.solutionStatus).toBe('POST_PROCESSED');
  expect(result.readings.find(r => r.id === 'imu-context')?.reasons).toContain('MOUNT_CALIBRATION_UNKNOWN');
});
it('preserves decimal epoch precision and composes mounting inverse without double-counting translation', () => {
  expect(decimalSecondsNs('1606417097.5462952')).toBe('1606417097546295200');
  expect(() => decimalSecondsNs('1.1234567891')).toThrow('precision');
  const mount = { rotation: [[0, -1, 0], [1, 0, 0], [0, 0, 1]], translationM: [1, 2, 3] as [number, number, number] };
  const body = { rotation: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], translationM: [10, 20, 30] as [number, number, number] };
  const recovered = compose(compose(body, mount), inverse(mount));
  expect(recovered).toEqual(body); expect(apply(recovered, [0, 0, 0])).toEqual([10, 20, 30]);
});

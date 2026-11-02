import { describe, expect, it } from 'vitest';
import { hasValidLearningConfiguration, isTemplateContent } from './creatorTemplates.js';

describe('optional Curriculum and Grade authoring contract', () => {
  it('accepts omitted selectors as Mixed without injecting or mutating fields', () => {
    for (const configuration of [{}, { curriculum: 'math' }, { grade: '9' }]) {
      const content = { configuration };
      const before = structuredClone(content);
      expect(hasValidLearningConfiguration(content)).toBe(true);
      expect(content).toEqual(before);
    }
  });
  for (const curriculum of ['mixed', 'math']) {
    it.each(['mixed', '9', '10', '11', '12'])(`accepts ${curriculum} with grade %s independently`, grade => {
      expect(hasValidLearningConfiguration({ configuration: { curriculum, grade, unrelated: 'preserved' } })).toBe(true);
    });
  }
  for (const field of ['curriculum', 'grade']) {
    it.each([null, '', 'Mixed', 'Math', '8', '13', 9, 10, true, [], {}])(`rejects invalid ${field} %j for new authoring`, value => {
      expect(hasValidLearningConfiguration({ configuration: { [field]: value } })).toBe(false);
    });
  }
  it('leaves historical content validation and data untouched', () => {
    for (const configuration of [{ legacy: true }, { curriculum: 'historical', grade: 7 }]) {
      const content = { key: 'legacy', version: 1, displayName: 'Legacy', theme: 'Explore',
        mission: { name: 'Go' }, configuration, scoring: { model: 'platform' }, checkpoints: [{}] };
      const before = structuredClone(content);
      expect(isTemplateContent(content, 'legacy', 1)).toBe(true);
      expect(content).toEqual(before);
    }
  });
});

import { describe,it,expect } from 'vitest';
import { validateContent } from './contentLibrary.js';
import { exerciseFixtures } from '../test/customExercises.js';
describe('Content Library canonical compatibility',()=>{
 for(const exercise of exerciseFixtures) it(`preserves ${exercise.type} exactly`,()=>{
  const e={...exercise,instructions:'Solve $\\frac{1}{2}$\n  ă ≥ π'};
  expect(validateContent({exercise:e}).exercise).toEqual(e);
  expect(validateContent({exercise:e}).geography).toEqual({scope:'universal'});
  expect(()=>validateContent({exercise:{...e,answer:{}}})).toThrow();
 });
 it('rejects invented contracts, identifiers and Template ownership',()=>{
  for(const input of [null,{}, {exercise:{...exerciseFixtures[0],id:'x'}}, {exercise:{...exerciseFixtures[0],classification:'navigation'}},
   {exercise:exerciseFixtures[0],curriculum:{main:'Algebra'}}, {exercise:exerciseFixtures[0],geography:{scope:'country',countryCode:'Romania'}}]) expect(()=>validateContent(input)).toThrow();
 });
 it('allows incomplete draft classification and existing grade IDs',()=>{
  expect(validateContent({exercise:exerciseFixtures[0],curriculum:{subject:'math',grade:'9'}}).curriculum.grade).toBe('9');
 });
});

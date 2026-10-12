import { createHash } from 'node:crypto';
import { createSignalClujNapocaStarter } from './signalClujNapocaStarter.js';
import { signalOverloadClujRouteProposal } from './signalOverloadClujRouteProposal.js';

// Gameplay stays in educational order. Only research geography is reversed.
const scenes = [
  {
    location: "Tailors' Tower — exterior", storyStage: 'ACCESS',
    storyProblem: 'An unexplained overload has silenced the fictional city network. At the tower exterior, your app finds a locked diagnostic session.',
    storyObjective: 'Open diagnostic access.',
    storyPlan: 'The number pattern protects an access token. Solve it to recover your command letters.',
    storyRisk: 'Without all four letter shares, the fault log stays locked.',
    storySuccess: 'UNLOCKED opens the fault log. A corrupted trace is tagged to the Reformed Church exterior; examine it next.',
    teamRevelation: 'The overload left a corrupted trace, not a complete network map.',
    nextDestination: 'Reformed Church — exterior',
  },
  {
    location: 'Reformed Church — exterior', storyStage: 'TRACE',
    storyProblem: 'The newly opened log contains a broken algebra trace. Its receiver identifier is hidden in a fictional diagnostic grid.',
    storyObjective: 'Find the corrupted step and trace the receiver.',
    storyPlan: 'Repair the algebra to recover one grid fact. Grid directions describe puzzle cells only.',
    storyRisk: 'A corrupted cell would identify the wrong receiver.',
    personalContribution: 'The repaired trace ends at receiver R',
    personalMask: 'YOUR FACT: THE REPAIRED TRACE ENDS AT RECEIVER R',
    publicContributions: ['Maya: Receiver R is opposite buffer B across access cell A in the same row.', 'Liam: Buffer B is east of access cell A.', 'You: The repaired trace ends at receiver R.', 'Zara: The diagnostic cursor is at access cell A.'],
    teamPrompt: 'In the fictional diagnostic grid, which direction from access cell A reaches receiver R?',
    teamDisplay: 'Diagnostic grid only; no walking directions',
    teamInstruction: 'Combine all four grid facts. WEST is a cell relationship, never a real-world route.',
    storySuccess: 'Receiver R lies WEST in the diagnostic grid. Its record is tagged to Saint George statue, where the next message packet can be examined.',
    teamRevelation: 'The trace reaches receiver R; its message is still unread.',
    nextDestination: 'Saint George statue',
  },
  {
    location: 'Saint George statue', storyStage: 'IDENTIFY',
    storyProblem: 'Receiver R holds four numbered packets. Their meaning may explain the overload, but yours is locked by a square pattern.',
    storyObjective: 'Identify what the receiver is reporting.',
    storyPlan: 'Complete the square to recover your packet; join all four with A=1 through Z=26.',
    storyRisk: 'One packet alone cannot identify the fault.',
    storySuccess: 'SIGNAL identifies the affected channel in the receiver record. That record reports a missing relay link tagged to Colegiul Academic exterior.',
    teamRevelation: 'The overload broke a relay link on the SIGNAL channel; rebuilding it is the next task.',
    nextDestination: 'Colegiul Academic — exterior',
  },
  {
    location: 'Colegiul Academic — exterior', storyStage: 'REPAIR',
    storyProblem: 'The missing link is represented by a dismantled relay model in your app. Four team operations can reconnect it.',
    storyObjective: 'Rebuild the relay link.',
    storyPlan: 'Build 24 with the number blocks to recover your operation. Combine every operation to find the restart frequency.',
    storyRisk: 'A working component alone cannot reconnect the relay.',
    storySuccess: 'Frequency 30 restarts the relay model. The repaired link delivers an encrypted payload tagged to the UBB main building exterior.',
    teamRevelation: 'The link works again, but its payload is encrypted and the final transmitter remains locked.',
    nextDestination: 'Babeș-Bolyai University — main building exterior',
  },
  {
    location: 'Babeș-Bolyai University — main building exterior', storyStage: 'DECODE',
    storyProblem: 'The restored link has delivered its payload. A radial lock protects your fragment of the cipher clue.',
    storyObjective: 'Open the encrypted payload.',
    storyPlan: 'Solve the radial pattern, then read all four riddle fragments in order.',
    storyRisk: 'Until the cipher is identified, the transmitter locator cannot be read.',
    storySuccess: 'CIPHER selects the payload decoder. The decoded record points to a noisy locator tagged to the Piarist Church exterior.',
    teamRevelation: 'The locator can reveal the transmitter, but false and repeated packets must first be filtered.',
    nextDestination: 'Piarist Church — exterior',
  },
  {
    location: 'Piarist Church — exterior', storyStage: 'LOCATE',
    storyProblem: 'The decoded locator mixes trustworthy packets with conflicting or repeated grid signals. These grid labels are fictional puzzle data.',
    storyObjective: 'Identify the final transmitter record.',
    storyPlan: 'Verify the prime frequency to recover your packet, then filter the four team contributions.',
    storyRisk: 'False packets hide the transmitter record; the mission is still unresolved.',
    personalContribution: 'EAST / EAST', personalMask: 'YOUR GRID PACKET: EAST / EAST (PUZZLE ONLY)',
    publicContributions: ['Maya: NORTH / SOUTH (conflicting grid labels)', 'Liam: MATTHIAS CORVINUS MONUMENT (destination record)', 'You: EAST / EAST (repeated grid labels)', 'Zara: WEST (single grid label)'],
    teamPrompt: 'Select the trustworthy locator packets; grid labels are puzzle content only.',
    teamDisplay: 'MATTHIAS CORVINUS MONUMENT / WEST (grid label only)',
    teamInstruction: 'Compare all four packets. Select Liam and Zara; discard conflicting or repeated labels. WEST is not a walking instruction.',
    successText: 'Prime frequency 29 verified. Your locator packet is ready.',
    storySuccess: 'The filtered locator identifies the final transmitter record at Matthias Corvinus monument in Piața Unirii. Its shared lock still needs all four Hunters.',
    teamRevelation: 'The final transmitter has been located, but only the shared key can restore communication.',
    nextDestination: 'Piața Unirii — Matthias Corvinus monument',
  },
  {
    location: 'Piața Unirii — Matthias Corvinus monument', storyStage: 'RESTORE',
    storyProblem: 'All six diagnostic links now reach the fictional final transmitter in your app. Four locks prevent an incomplete restart.',
    storyObjective: 'Restore communication with the shared team key.',
    storyPlan: 'Complete the prime sequence to reveal your digit, then combine all four digits using the ordering rule.',
    storyRisk: 'No single Hunter can open the transmitter; all four contributions are required.',
    storySuccess: 'Key 2397 opens the shared lock. All six links synchronize and the overload clears. The first message returns: “We can hear you.” Your team has restored the fictional city network together.',
    teamRevelation: 'The missing link, encrypted payload and noisy locator are resolved. Communication returns only after the shared restart.',
    nextDestination: 'MISSION COMPLETE',
  },
] as const;

/** Separate reviewable definition. Never seed this into the approved platform catalog. */
export const signalOverloadClujNapocaV1 = (() => {
  const source = createSignalClujNapocaStarter('signal-overload-cluj-napoca');
  const { starterSource, ...base } = source;
  return {
    ...base,
    displayName: 'Signal Overload - Cluj Napoca', theme: 'Signal Overload',
    mission: {
      name: 'Restore the overloaded network', signal: 'SIGNAL OVERLOAD: CLUJ NAPOCA',
      briefing: "An unexplained overload has disrupted a fictional communication network. Begin at Tailors' Tower exterior. Diagnose the fault, repair the links and unlock the final transmitter together. All network equipment exists only in the story and app; buildings and monuments contain no game equipment.",
      finishLocation: 'Piața Unirii — Matthias Corvinus monument',
    },
    routeResearch: {
      ...source.routeResearch, proposal: structuredClone(signalOverloadClujRouteProposal),
      note: 'Landmark identities and reference pins are research only. Arrival areas, GPS, crossings, distances, walking navigation and physical verification remain pending. Original proposal positional wording refers to the original sequence. Fictional diagnostic-grid directions are puzzle data only.',
    },
    checkpoints: source.checkpoints.map((entry, index) => {
      const { fictionalNavigation, ...gameplay } = entry;
      return { ...gameplay, ...scenes[index], navigationMode: 'none' as const };
    }),
  };
})();

export const SIGNAL_OVERLOAD_CLUJ_NAPOCA_V1_CHECKPOINTS_SHA256 = createHash('sha256')
  .update(JSON.stringify(signalOverloadClujNapocaV1.checkpoints)).digest('hex');

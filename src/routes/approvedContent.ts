import { Router, type RequestHandler } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { ContentError, uuid } from '../domain/contentLibrary.js';
import { approvedQuery } from '../domain/approvedContent.js';
import { ApprovedContent } from '../models/ApprovedContent.js';

const router=Router();
router.use(requireAuth,requireRole('creator'));
const handle=(fn:RequestHandler):RequestHandler=>async(req,res,next)=>{
 try {await fn(req,res,next);} catch(error) {
  if(error instanceof ContentError) return res.status(error.status).json({error:error.code});
  return next(error);
 }
};
router.get('/',handle(async(req,res)=>res.json(await ApprovedContent.list(approvedQuery(req.query)))));
router.get('/:contentId/revisions/:revisionId',handle(async(req,res)=>{
 if(!uuid(req.params.contentId)||!uuid(req.params.revisionId)) throw new ContentError('invalid_revision_id');
 return res.json(await ApprovedContent.detail(req.params.contentId,req.params.revisionId));
}));
export const approvedContentRouter=router;

/**
 * @openapi
 * components:
 *   schemas:
 *     ApprovedLibraryMetadata:
 *       type: object
 *       required: [contentId, revisionId, version, status, classification, type, title, category, curriculum, geography]
 *       properties:
 *         contentId: {type: string, format: uuid}
 *         revisionId: {type: string, format: uuid}
 *         version: {type: integer, minimum: 1}
 *         status: {type: string, enum: [approved]}
 *         classification: {type: string, enum: [personal, team]}
 *         type:
 *           type: string
 *           enum: [tap-pair, single-choice, true-false, memory-card, number-line, multiple-choice, match-columns, drag-drop, fill-blank, sequence, find-mistake, build-problem, number-pattern, shape-pattern, rule-discovery, scrambled-word, distributed-information, hypothesis, assemble-machine, clue-synthesis, filter-noise, shared-final-key]
 *         title: {type: string}
 *         category: {type: string, nullable: true, enum: [Mathematics, History, Science, Mixed, null]}
 *         curriculum:
 *           type: object
 *           additionalProperties: false
 *           properties:
 *             subject: {type: string, enum: [math]}
 *             grade: {type: string, enum: ['5', '6', '7', '8', '9', '10', '11', '12']}
 *         geography:
 *           $ref: '#/components/schemas/LibraryGeography'
 *     ApprovedLibraryDetail:
 *       allOf:
 *       - $ref: '#/components/schemas/ApprovedLibraryMetadata'
 *       - type: object
 *         required: [exercise]
 *         properties:
 *           exercise:
 *             $ref: '#/components/schemas/LibraryExercise'
 *   responses:
 *     ApprovedLibraryBadRequest:
 *       description: Invalid identifiers, filters, pagination or expired/tampered/mismatched cursor
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Error'
 *     ApprovedLibraryUnauthorized:
 *       description: Missing, invalid, blocked or retired identity
 *     ApprovedLibraryForbidden:
 *       description: Creator capability required; guests forbidden
 * paths:
 *   /api/creator/content/approved:
 *     get:
 *       tags: [Content Library]
 *       summary: Discover the latest approved revision per Content across Creators
 *       description: Approval-backed revisions only; newer drafts never hide approved history. Lightweight metadata without exercise payload or Creator identity. Selection of the latest approval precedes filters. Without geography filters, browse all locations. With a country, include universal and country content; a canonical region adds that region, and a canonical city adds its region and exact city. Unknown or mismatched cities fall back to universal and requested country only. Ordering is Content UUID ascending. Opaque signed cursors freeze approval visibility and revision selection at page one, including exclusion of then-uncommitted approvals. Repeat the same filters; cursor chain expires 15 minutes after page one. Start a fresh search to see new approvals.
 *       security:
 *       - bearerAuth: []
 *       parameters:
 *       - in: query
 *         name: limit
 *         schema: {type: integer, minimum: 1, maximum: 100, default: 50}
 *       - in: query
 *         name: after
 *         description: Opaque nextAfter token from the preceding page; repeat all filters
 *         schema: {type: string, maxLength: 12000}
 *       - in: query
 *         name: classification
 *         schema: {type: string, enum: [personal, team]}
 *       - in: query
 *         name: type
 *         description: Supported mechanic identifier; must agree with classification when both supplied
 *         schema:
 *           type: string
 *           enum: [tap-pair, single-choice, true-false, memory-card, number-line, multiple-choice, match-columns, drag-drop, fill-blank, sequence, find-mistake, build-problem, number-pattern, shape-pattern, rule-discovery, scrambled-word, distributed-information, hypothesis, assemble-machine, clue-synthesis, filter-noise, shared-final-key]
 *       - in: query
 *         name: category
 *         schema: {type: string, enum: [Mathematics, History, Science, Mixed]}
 *       - in: query
 *         name: grade
 *         description: Specific grades match explicitly classified Mathematics only; unspecified matches absent grade, never every grade
 *         schema: {type: string, enum: [unspecified, '5', '6', '7', '8', '9', '10', '11', '12']}
 *       - in: query
 *         name: q
 *         description: Trimmed case-insensitive literal substring in title or instructions; percent and underscore are literal characters
 *         schema: {type: string, minLength: 1, maxLength: 200}
 *       - in: query
 *         name: countryCode
 *         schema: {type: string, pattern: '^[A-Z]{2}$'}
 *       - in: query
 *         name: admin1Code
 *         description: Canonical region identifier; requires countryCode, mutually exclusive with geographicId
 *         schema: {type: string, pattern: '^[A-Za-z0-9-]{1,40}$'}
 *       - in: query
 *         name: geographicId
 *         description: GeoNames city ID as a string; requires countryCode, mutually exclusive with admin1Code. Hierarchy comes only from canonical catalogs.
 *         schema: {type: string, pattern: '^[1-9][0-9]{0,17}$'}
 *       responses:
 *         '200':
 *           description: Bounded metadata page, one exact latest approved revision per Content
 *           content:
 *             application/json:
 *               schema:
 *                 type: object
 *                 required: [items, nextAfter]
 *                 properties:
 *                   items:
 *                     type: array
 *                     maxItems: 100
 *                     items:
 *                       $ref: '#/components/schemas/ApprovedLibraryMetadata'
 *                   nextAfter: {type: string, nullable: true}
 *         '400':
 *           $ref: '#/components/responses/ApprovedLibraryBadRequest'
 *         '401':
 *           $ref: '#/components/responses/ApprovedLibraryUnauthorized'
 *         '403':
 *           $ref: '#/components/responses/ApprovedLibraryForbidden'
 *   /api/creator/content/approved/{contentId}/revisions/{revisionId}:
 *     get:
 *       tags: [Content Library]
 *       summary: Read an exact approval-backed revision across Creators
 *       description: Older approved revisions remain available. Returns complete canonical data including answers, hints, validation fields, feedback, solution and LaTeX. No owner identity or review actor data. Never substitutes another revision. Nonapproved, mismatched or unsupported revisions return 404.
 *       security:
 *       - bearerAuth: []
 *       parameters:
 *       - in: path
 *         name: contentId
 *         required: true
 *         schema: {type: string, format: uuid}
 *       - in: path
 *         name: revisionId
 *         required: true
 *         schema: {type: string, format: uuid}
 *       responses:
 *         '200':
 *           description: Exact approved canonical revision
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/ApprovedLibraryDetail'
 *         '400':
 *           $ref: '#/components/responses/ApprovedLibraryBadRequest'
 *         '401':
 *           $ref: '#/components/responses/ApprovedLibraryUnauthorized'
 *         '403':
 *           $ref: '#/components/responses/ApprovedLibraryForbidden'
 *         '404':
 *           description: No eligible approved revision with these exact identifiers
 */

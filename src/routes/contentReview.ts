import { Router, type RequestHandler } from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import { ContentError, reviewComment, uuid } from '../domain/contentLibrary.js';
import { ContentReview } from '../models/ContentReview.js';

export const contentHandler = (fn: RequestHandler): RequestHandler => async (req,res,next) => {
 try { await fn(req,res,next); } catch (error) {
  if (error instanceof ContentError) return res.status(error.status).json({error:error.code,...(error.details ? {details:error.details} : {})});
  return next(error);
 }
};
export function contentPagination(query: Record<string,unknown>) {
 const limit = query.limit === undefined ? 50 : Number(query.limit), after = query.after;
 if (!Number.isInteger(limit) || limit<1 || limit>100 || (query.limit!==undefined && typeof query.limit!=='string') || (after!==undefined && !uuid(after))) throw new ContentError('invalid_pagination');
 return {limit,after:after as string|undefined};
}
export function emptyContentBody(body: unknown) {
 if (body != null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) throw new ContentError('invalid_review_body');
}
const router = Router();
router.use(requireAuth, requireRole('admin'));
router.param('id',(_req,res,next,id)=>uuid(id)?next():res.status(400).json({error:'invalid_content_id'}));
router.param('revisionId',(_req,res,next,id)=>uuid(id)?next():res.status(400).json({error:'invalid_revision_id'}));
router.get('/',contentHandler(async(req,res)=>{
 const {limit,after}=contentPagination(req.query);
 return res.json(await ContentReview.queue(limit,after));
}));
router.get('/:id/revisions/:revisionId',contentHandler(async(req,res)=>res.json(await ContentReview.detail(req.params.id as string,req.params.revisionId as string))));
for (const [action,decision] of [['approve','approved'],['request-changes','changes_requested']] as const) {
 router.post(`/:id/revisions/:revisionId/${action}`,contentHandler(async(req:AuthRequest,res)=>{
  const body = req.body;
  if (body != null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k=>k!=='comment'))) throw new ContentError('invalid_review_body');
  const comment = reviewComment(body?.comment,decision==='changes_requested');
  return res.json(await ContentReview.transition(req.user!.id,req.params.id as string,req.params.revisionId as string,decision,comment));
 }));
}
export const adminContentReviewRouter = router;

/**
 * @openapi
 * components:
 *   schemas:
 *     LibraryReviewEvent:
 *       type: object
 *       required:
 *       - eventId
 *       - contentId
 *       - revisionId
 *       - actorUserId
 *       - decision
 *       - comment
 *       - decidedAt
 *       properties:
 *         eventId:
 *           type: string
 *           format: uuid
 *         contentId:
 *           type: string
 *           format: uuid
 *         revisionId:
 *           type: string
 *           format: uuid
 *         actorUserId:
 *           type: string
 *           format: uuid
 *         decision:
 *           type: string
 *           enum:
 *           - submitted
 *           - approved
 *           - changes_requested
 *         comment:
 *           type: string
 *           nullable: true
 *         decidedAt:
 *           type: string
 *           format: date-time
 *     LibraryReviewQueueItem:
 *       type: object
 *       properties:
 *         contentId:
 *           type: string
 *           format: uuid
 *         revisionId:
 *           type: string
 *           format: uuid
 *         version:
 *           type: integer
 *         status:
 *           type: string
 *           enum:
 *           - submitted
 *         title:
 *           type: string
 *         classification:
 *           type: string
 *           enum:
 *           - personal
 *           - team
 *         type:
 *           type: string
 *         category:
 *           type: string
 *         curriculum:
 *           type: object
 *         geographicScope:
 *           type: string
 *           enum:
 *           - universal
 *           - country
 *           - region
 *           - city
 *         countryCode:
 *           type: string
 *           nullable: true
 *         admin1Code:
 *           type: string
 *           nullable: true
 *         geographicId:
 *           type: string
 *           nullable: true
 *         submittedAt:
 *           type: string
 *           format: date-time
 * paths:
 *   /api/creator/content/{id}/revisions/{revisionId}/submit:
 *     post:
 *       tags:
 *       - Content Library Review
 *       summary: Owner Creator submits exact current draft; requires category and canonical
 *         valid exercise
 *       security:
 *       - bearerAuth: []
 *       parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: revisionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       responses:
 *         '200':
 *           description: Updated exact revision envelope
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/LibraryContent'
 *         '400':
 *           description: Invalid payload, metadata, comment, identifier or pagination
 *         '401':
 *           description: Authentication required
 *         '403':
 *           description: Active role required; owner cannot review own Content
 *         '404':
 *           description: Content/revision absent, not owned or not currently submitted
 *         '409':
 *           description: Stale head, invalid lifecycle or duplicate decision
 *       requestBody:
 *         required: false
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *   /api/admin/content/review/{id}/revisions/{revisionId}:
 *     get:
 *       tags:
 *       - Content Library Review
 *       summary: Admin inspects exact current submitted revision with complete canonical
 *         payload, geography, owner ID and events
 *       security:
 *       - bearerAuth: []
 *       parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: revisionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       responses:
 *         '200':
 *           description: Updated exact revision envelope
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/LibraryContent'
 *         '400':
 *           description: Invalid payload, metadata, comment, identifier or pagination
 *         '401':
 *           description: Authentication required
 *         '403':
 *           description: Active role required; owner cannot review own Content
 *         '404':
 *           description: Content/revision absent, not owned or not currently submitted
 *         '409':
 *           description: Stale head, invalid lifecycle or duplicate decision
 *   /api/admin/content/review/{id}/revisions/{revisionId}/approve:
 *     post:
 *       tags:
 *       - Content Library Review
 *       summary: Independent Admin approves exact submitted revision
 *       security:
 *       - bearerAuth: []
 *       parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: revisionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       responses:
 *         '200':
 *           description: Updated exact revision envelope
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/LibraryContent'
 *         '400':
 *           description: Invalid payload, metadata, comment, identifier or pagination
 *         '401':
 *           description: Authentication required
 *         '403':
 *           description: Active role required; owner cannot review own Content
 *         '404':
 *           description: Content/revision absent, not owned or not currently submitted
 *         '409':
 *           description: Stale head, invalid lifecycle or duplicate decision
 *       requestBody:
 *         required: false
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               properties:
 *                 comment:
 *                   type: string
 *                   minLength: 3
 *                   maxLength: 1000
 *                   description: Trimmed plain text containing a letter or digit
 *   /api/admin/content/review/{id}/revisions/{revisionId}/request-changes:
 *     post:
 *       tags:
 *       - Content Library Review
 *       summary: Independent Admin requests changes with meaningful feedback
 *       security:
 *       - bearerAuth: []
 *       parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: path
 *         name: revisionId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       responses:
 *         '200':
 *           description: Updated exact revision envelope
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/LibraryContent'
 *         '400':
 *           description: Invalid payload, metadata, comment, identifier or pagination
 *         '401':
 *           description: Authentication required
 *         '403':
 *           description: Active role required; owner cannot review own Content
 *         '404':
 *           description: Content/revision absent, not owned or not currently submitted
 *         '409':
 *           description: Stale head, invalid lifecycle or duplicate decision
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               properties:
 *                 comment:
 *                   type: string
 *                   minLength: 3
 *                   maxLength: 1000
 *                   description: Trimmed plain text containing a letter or digit
 *               required:
 *               - comment
 *   /api/admin/content/review:
 *     get:
 *       tags:
 *       - Content Library Review
 *       summary: Paginated Admin queue of submitted Content revisions
 *       security:
 *       - bearerAuth: []
 *       parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *       - in: query
 *         name: after
 *         required: false
 *         schema:
 *           type: string
 *           format: uuid
 *       responses:
 *         '400':
 *           description: Invalid payload, metadata, comment, identifier or pagination
 *         '401':
 *           description: Authentication required
 *         '403':
 *           description: Active role required; owner cannot review own Content
 *         '404':
 *           description: Content/revision absent, not owned or not currently submitted
 *         '409':
 *           description: Stale head, invalid lifecycle or duplicate decision
 *         '200':
 *           description: Current submitted heads only; UUID keyset cursor refers to
 *             revisionId; no owner PII or answers
 *           content:
 *             application/json:
 *               schema:
 *                 type: object
 *                 required:
 *                 - items
 *                 - nextAfter
 *                 properties:
 *                   items:
 *                     type: array
 *                     items:
 *                       $ref: '#/components/schemas/LibraryReviewQueueItem'
 *                   nextAfter:
 *                     type: string
 *                     format: uuid
 *                     nullable: true
 */

import { ContentReview } from '../models/ContentReview.js';
import { emptyContentBody } from './contentReview.js';
import { Router, type RequestHandler } from 'express';
import { requireAuth, requireRole, type AuthRequest } from '../middleware/auth.js';
import { ContentError, uuid } from '../domain/contentLibrary.js';
import { ContentLibrary } from '../models/ContentLibrary.js';
const router=Router();
router.use(requireAuth,requireRole('creator'));
const handle=(fn:RequestHandler):RequestHandler=>async(req,res,next)=>{
 try {await fn(req,res,next);} catch(error) {
  if(error instanceof ContentError) return res.status(error.status).json({error:error.code,...(error.details?{details:error.details}:{})});
  return next(error);
 }
};
router.param('id',(_req,res,next,id)=>uuid(id)?next():res.status(400).json({error:'invalid_content_id'}));
router.get('/',handle(async(req:AuthRequest,res)=>{
 const limit=req.query.limit===undefined?50:Number(req.query.limit),after=req.query.after;
 if (!Number.isInteger(limit)||limit<1||limit>100||(req.query.limit!==undefined&&typeof req.query.limit!=='string')||(after!==undefined&&!uuid(after))) return res.status(400).json({error:'invalid_pagination'});
 if(req.query.view!==undefined && req.query.view!=='all') throw new ContentError('invalid_view');
 return res.json(await ContentLibrary.list(req.user!.id,limit,after as string|undefined,req.query.view==='all'));
}));
router.post('/',handle(async(req:AuthRequest,res)=>{
 if(req.body && Object.hasOwn(req.body,'baseRevisionId')) throw new ContentError('invalid_content');
 return res.status(201).json(await ContentLibrary.save(req.user!.id,req.body));
}));
router.get('/:id',handle(async(req:AuthRequest,res)=>res.json(await ContentLibrary.get(req.user!.id,req.params.id as string))));
router.get('/:id/revisions/:revisionId',handle(async(req:AuthRequest,res)=>{
 if(!uuid(req.params.revisionId)) throw new ContentError('invalid_revision_id');
 return res.json(await ContentLibrary.get(req.user!.id,req.params.id as string,req.params.revisionId));
}));
router.post('/:id/revisions/:revisionId/submit',handle(async(req:AuthRequest,res)=>{
 if(!uuid(req.params.revisionId)) throw new ContentError('invalid_revision_id');
 emptyContentBody(req.body);
 return res.json(await ContentReview.transition(req.user!.id,req.params.id as string,req.params.revisionId,'submitted'));
}));
router.put('/:id',handle(async(req:AuthRequest,res)=>{
 if(!uuid(req.body?.baseRevisionId)) throw new ContentError('invalid_base_revision_id');
 return res.json(await ContentLibrary.save(req.user!.id,req.body,req.params.id as string,req.body.baseRevisionId));
}));
router.post('/:id/revisions',handle(async(req:AuthRequest,res)=>{
 if(!uuid(req.body?.baseRevisionId)||Object.keys(req.body).length!==1) throw new ContentError('invalid_base_revision_id');
 return res.status(201).json(await ContentLibrary.save(req.user!.id,undefined,req.params.id as string,req.body.baseRevisionId,true));
}));
export const creatorContentRouter=router;


/**
 * @openapi
 * components:
 *   schemas:
 *     LibraryGeography:
 *       oneOf:
 *       - type: object
 *         additionalProperties: false
 *         required:
 *         - scope
 *         properties:
 *           scope:
 *             type: string
 *             enum:
 *             - universal
 *       - type: object
 *         additionalProperties: false
 *         required:
 *         - scope
 *         - countryCode
 *         properties:
 *           scope:
 *             type: string
 *             enum:
 *             - country
 *           countryCode:
 *             type: string
 *       - type: object
 *         additionalProperties: false
 *         required:
 *         - scope
 *         - countryCode
 *         - admin1Code
 *         properties:
 *           scope:
 *             type: string
 *             enum:
 *             - region
 *           countryCode:
 *             type: string
 *           admin1Code:
 *             type: string
 *       - type: object
 *         additionalProperties: false
 *         required:
 *         - scope
 *         - countryCode
 *         - geographicId
 *         properties:
 *           scope:
 *             type: string
 *             enum:
 *             - city
 *           countryCode:
 *             type: string
 *           geographicId:
 *             type: string
 *     LibraryDraft:
 *       type: object
 *       additionalProperties: false
 *       required:
 *       - exercise
 *       properties:
 *         exercise:
 *           $ref: '#/components/schemas/LibraryExercise'
 *         category:
 *           type: string
 *           nullable: true
 *           maxLength: 100
 *           enum:
 *           - Mathematics
 *           - History
 *           - Science
 *           - Mixed
 *         curriculum:
 *           type: object
 *           additionalProperties: false
 *           properties:
 *             subject:
 *               type: string
 *               enum:
 *               - math
 *             grade:
 *               type: string
 *               enum:
 *               - '5'
 *               - '6'
 *               - '7'
 *               - '8'
 *               - '9'
 *               - '10'
 *               - '11'
 *               - '12'
 *         geography:
 *           $ref: '#/components/schemas/LibraryGeography'
 *     LibraryContent:
 *       type: object
 *       required:
 *       - contentId
 *       - revisionId
 *       - ownerId
 *       - version
 *       - status
 *       - exercise
 *       - createdAt
 *       - updatedAt
 *       - reviewEvents
 *       - category
 *       - curriculum
 *       - geography
 *       properties:
 *         contentId:
 *           type: string
 *           format: uuid
 *         revisionId:
 *           type: string
 *           format: uuid
 *         ownerId:
 *           type: string
 *           format: uuid
 *         createdAt:
 *           type: string
 *           format: date-time
 *         updatedAt:
 *           type: string
 *           format: date-time
 *         version:
 *           type: integer
 *           minimum: 1
 *         status:
 *           type: string
 *           enum:
 *           - draft
 *           - submitted
 *           - approved
 *           - changes_requested
 *           - archived
 *         reviewEvents:
 *           type: array
 *           description: Ordered immutable events for this exact revision
 *           items:
 *             $ref: '#/components/schemas/LibraryReviewEvent'
 *         exercise:
 *           $ref: '#/components/schemas/LibraryExercise'
 *         category:
 *           type: string
 *           nullable: true
 *           enum:
 *           - Mathematics
 *           - History
 *           - Science
 *           - Mixed
 *         curriculum:
 *           type: object
 *         geography:
 *           $ref: '#/components/schemas/LibraryGeography'
 * paths:
 *   /api/creator/content:
 *     post:
 *       tags:
 *       - Content Library
 *       summary: Create own draft
 *       security:
 *       - bearerAuth: []
 *       responses:
 *         '201':
 *           description: Content response
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/LibraryContent'
 *         '400':
 *           description: Invalid payload, identifier or pagination
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '401':
 *           description: Authentication required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '403':
 *           description: Active non-guest Creator required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '404':
 *           description: Not owned or absent
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '409':
 *           description: Stale revision, non-draft update or archived head
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '413':
 *           description: Payload too large
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *       parameters: []
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/LibraryDraft'
 *     get:
 *       tags:
 *       - Content Library
 *       summary: List own draft heads; view=all includes submitted and reviewed current heads
 *       security:
 *       - bearerAuth: []
 *       responses:
 *         '200':
 *           description: Content response
 *           content:
 *             application/json:
 *               schema:
 *                 type: object
 *                 properties:
 *                   items:
 *                     type: array
 *                     items:
 *                       $ref: '#/components/schemas/LibraryContent'
 *                   nextAfter:
 *                     type: string
 *                     format: uuid
 *                     nullable: true
 *         '400':
 *           description: Invalid payload, identifier or pagination
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '401':
 *           description: Authentication required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '403':
 *           description: Active non-guest Creator required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '404':
 *           description: Not owned or absent
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '409':
 *           description: Stale revision, non-draft update or archived head
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '413':
 *           description: Payload too large
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *       parameters:
 *       - in: query
 *         name: view
 *         description: Omit for compatible draft-only list; all includes every own current head. Retrieve old feedback by exact revision route.
 *         schema:
 *           type: string
 *           enum: [all]
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *       - in: query
 *         name: after
 *         schema:
 *           type: string
 *           format: uuid
 *   /api/creator/content/{id}:
 *     get:
 *       tags:
 *       - Content Library
 *       summary: Retrieve own current revision
 *       security:
 *       - bearerAuth: []
 *       responses:
 *         '200':
 *           description: Content response
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/LibraryContent'
 *         '400':
 *           description: Invalid payload, identifier or pagination
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '401':
 *           description: Authentication required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '403':
 *           description: Active non-guest Creator required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '404':
 *           description: Not owned or absent
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '409':
 *           description: Stale revision, non-draft update or archived head
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '413':
 *           description: Payload too large
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *       parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     put:
 *       tags:
 *       - Content Library
 *       summary: Append draft update; baseRevisionId must match current head
 *       security:
 *       - bearerAuth: []
 *       responses:
 *         '200':
 *           description: Content response
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/LibraryContent'
 *         '400':
 *           description: Invalid payload, identifier or pagination
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '401':
 *           description: Authentication required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '403':
 *           description: Active non-guest Creator required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '404':
 *           description: Not owned or absent
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '409':
 *           description: Stale revision, non-draft update or archived head
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '413':
 *           description: Payload too large
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *       parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required:
 *               - exercise
 *               - baseRevisionId
 *               properties:
 *                 exercise:
 *                   $ref: '#/components/schemas/LibraryExercise'
 *                 category:
 *                   type: string
 *                   nullable: true
 *                   maxLength: 100
 *                   enum:
 *                   - Mathematics
 *                   - History
 *                   - Science
 *                   - Mixed
 *                 curriculum:
 *                   type: object
 *                   additionalProperties: false
 *                   properties:
 *                     subject:
 *                       type: string
 *                       enum:
 *                       - math
 *                     grade:
 *                       type: string
 *                       enum:
 *                       - '5'
 *                       - '6'
 *                       - '7'
 *                       - '8'
 *                       - '9'
 *                       - '10'
 *                       - '11'
 *                       - '12'
 *                 geography:
 *                   $ref: '#/components/schemas/LibraryGeography'
 *                 baseRevisionId:
 *                   type: string
 *                   format: uuid
 *   /api/creator/content/{id}/revisions:
 *     post:
 *       tags:
 *       - Content Library
 *       summary: Clone current revision into a new draft
 *       security:
 *       - bearerAuth: []
 *       responses:
 *         '201':
 *           description: Content response
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/LibraryContent'
 *         '400':
 *           description: Invalid payload, identifier or pagination
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '401':
 *           description: Authentication required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '403':
 *           description: Active non-guest Creator required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '404':
 *           description: Not owned or absent
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '409':
 *           description: Stale revision, non-draft update or archived head
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '413':
 *           description: Payload too large
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *       parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       requestBody:
 *         required: true
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               additionalProperties: false
 *               required:
 *               - baseRevisionId
 *               properties:
 *                 baseRevisionId:
 *                   type: string
 *                   format: uuid
 *   /api/creator/content/{id}/revisions/{revisionId}:
 *     get:
 *       tags:
 *       - Content Library
 *       summary: Retrieve exact own immutable revision
 *       security:
 *       - bearerAuth: []
 *       responses:
 *         '200':
 *           description: Content response
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/LibraryContent'
 *         '400':
 *           description: Invalid payload, identifier or pagination
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '401':
 *           description: Authentication required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '403':
 *           description: Active non-guest Creator required
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '404':
 *           description: Not owned or absent
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '409':
 *           description: Stale revision, non-draft update or archived head
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
 *         '413':
 *           description: Payload too large
 *           content:
 *             application/json:
 *               schema:
 *                 $ref: '#/components/schemas/Error'
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
 */

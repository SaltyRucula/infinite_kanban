import { Router } from 'express';
import { strictRecord } from '@ai-agent-board/shared/execution.js';
import type { BoardWorkflowCoordinator } from '../services/board-workflow.js';
/** Board API only. Endpoints report via A2A artifacts, never this API. */
export function createBoardWorkflowRouter(coordinator:BoardWorkflowCoordinator):Router {
 const router=Router();
 router.get('/:id/workflow',async(req,res,next)=>{try{const run=await coordinator.get(String(req.params.id));if(!run){res.status(404).json({error:'workflow not found'});return;}res.json(run);}catch(e){next(e);}});
 router.post('/:id/workflow/run',async(req,res)=>{try{strictRecord(req.body,['repository','baseRevision','requiredCapabilities','policy']);res.status(202).json(await coordinator.start(String(req.params.id),req.body));}catch(e){res.status(400).json({error:e instanceof Error?e.message:'invalid workflow'});}});
 router.post('/:id/workflow/approve',async(req,res)=>{try{strictRecord(req.body,['revision']);}catch(e){res.status(400).json({error:e instanceof Error?e.message:'invalid approval'});return;}try{res.json(await coordinator.approve(String(req.params.id),req.body.revision,res.locals.principal?.id??'board-operator'));}catch(e){res.status(409).json({error:e instanceof Error?e.message:'invalid approval'});}});
 router.post('/:id/workflow/cancel',async(req,res)=>{try{strictRecord(req.body??{},[]);res.json(await coordinator.cancel(String(req.params.id)));}catch(e){res.status(409).json({error:e instanceof Error?e.message:'invalid cancellation'});}});
 router.post('/:id/workflow/retry',async(req,res)=>{try{strictRecord(req.body??{},[]);res.json(await coordinator.retry(String(req.params.id)));}catch(e){res.status(409).json({error:e instanceof Error?e.message:'invalid retry'});}});
 return router;
}

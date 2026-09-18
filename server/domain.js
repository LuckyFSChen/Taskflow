import {recordClarification} from './clarifications.js';
import { z } from 'zod';
import { id,now } from './db.js';
import { defaultBrowserValidation } from './browser-capability.js';
export const engine=z.enum(['codex','claude']);
export const taskInput=z.object({title:z.string().trim().min(2).max(140),description:z.string().trim().min(5).max(16000),projectId:z.string().uuid(),type:z.enum(['code','research']),priority:z.number().int().min(0).max(3).default(1),planner:engine.default('claude'),executor:engine.default('codex'),reviewer:engine.default('claude')});
export const planSchema=z.object({summary:z.string().min(1),acceptance:z.array(z.string().min(1)).min(1).max(20),questions:z.array(z.string()).max(10),steps:z.array(z.object({title:z.string().min(1),role:z.string().min(1),instructions:z.string().min(1)}).strict()).min(1).max(8)}).strict();
export const browserCheckSchema=z.object({description:z.string().min(1),passed:z.boolean()}).strict();
export const browserValidationSchema=z.object({
  required:z.boolean(),
  status:z.enum(['not_required','pending','running','passed','failed','blocked']),
  executed:z.boolean(),
  passed:z.boolean().nullable(),
  toolUsed:z.boolean(),
  toolCallCount:z.number().int().min(0),
  categories:z.record(z.string(),z.number().int().min(0)).default({}),
  url:z.string().nullable(),
  checks:z.array(browserCheckSchema),
  consoleErrors:z.array(z.string()),
  networkErrors:z.array(z.string()),
  notes:z.string(),
  error:z.string().nullable(),
}).strict();
export const manualActionSchema=z.object({
  required:z.boolean(),
  reason:z.string().nullable(),
  actionType:z.string().nullable(),
  commands:z.array(z.string()),
  workingDirectory:z.string().nullable(),
  instructions:z.string().nullable(),
  verification:z.array(z.string()),
  requiresAdministrator:z.boolean().nullable(),
}).strict();
export function defaultManualAction(){return {required:false,reason:null,actionType:null,commands:[],workingDirectory:null,instructions:null,verification:[],requiresAdministrator:null};}
export const resultSchema=z.object({summary:z.string(),questions:z.array(z.string()),artifacts:z.array(z.string()),passed:z.boolean(),evidence:z.array(z.string()),browserValidation:browserValidationSchema.default(defaultBrowserValidation),userActionRequired:manualActionSchema.default(defaultManualAction)}).strict();
export const planJson={type:'object',additionalProperties:false,required:['summary','acceptance','questions','steps'],properties:{summary:{type:'string'},acceptance:{type:'array',items:{type:'string'},minItems:1,maxItems:20},questions:{type:'array',items:{type:'string'},maxItems:10},steps:{type:'array',minItems:1,maxItems:8,items:{type:'object',additionalProperties:false,required:['title','role','instructions'],properties:{title:{type:'string'},role:{type:'string'},instructions:{type:'string'}}}}}};
const browserValidationJson={type:'object',additionalProperties:false,properties:{
  required:{type:'boolean'},
  status:{type:'string',enum:['not_required','pending','running','passed','failed','blocked']},
  executed:{type:'boolean'},
  passed:{type:['boolean','null']},
  toolUsed:{type:'boolean'},
  toolCallCount:{type:'integer'},
  categories:{type:'object',additionalProperties:{type:'integer'}},
  url:{type:['string','null']},
  checks:{type:'array',items:{type:'object',additionalProperties:false,required:['description','passed'],properties:{description:{type:'string'},passed:{type:'boolean'}}}},
  consoleErrors:{type:'array',items:{type:'string'}},
  networkErrors:{type:'array',items:{type:'string'}},
  notes:{type:'string'},
  error:{type:['string','null']},
}};
const manualActionJson={type:'object',additionalProperties:false,properties:{
  required:{type:'boolean'},
  reason:{type:['string','null']},
  actionType:{type:['string','null']},
  commands:{type:'array',items:{type:'string'}},
  workingDirectory:{type:['string','null']},
  instructions:{type:['string','null']},
  verification:{type:'array',items:{type:'string'}},
  requiresAdministrator:{type:['boolean','null']},
}};
export const resultJson={type:'object',additionalProperties:false,required:['summary','questions','artifacts','passed','evidence'],properties:{summary:{type:'string'},questions:{type:'array',items:{type:'string'}},artifacts:{type:'array',items:{type:'string'}},passed:{type:'boolean'},evidence:{type:'array',items:{type:'string'}},browserValidation:browserValidationJson,userActionRequired:manualActionJson}};
export class HttpError extends Error {constructor(status,message){super(message);this.status=status;}}
export function requireTask(store,user,tid) {const t=store.task(tid); if(!t || (t.ownerId!==user.id&&user.role!=='admin')) throw new HttpError(404,'找不到任務');return t;}
export function createTask(store,user,input) {const data=taskInput.parse(input);if(!store.hasProject(user,data.projectId)) throw new HttpError(403,'尚未獲授權使用此專案');const t={...data,id:id(),ownerId:user.id,status:'planning',position:Date.now(),created:now(),planVersion:1,approvedVersion:null,plan:null,round:0,questions:[],error:null,workspace:null,publishApproval:null,userActionRequired:null};store.saveTask(t);store.event(t.id,'created','任務已建立，等待根節點規劃');return t;}
export function approveTask(store,user,tid,version) {const t=requireTask(store,user,tid);if(t.status!=='awaiting_approval'||!t.plan||version!==t.planVersion) throw new HttpError(409,'計畫已變更或不在待審核狀態，請重新讀取');if(t.questions.length)throw new HttpError(409,'請先回答待確認問題'); t.approvedVersion=version;t.status='queued';store.saveTask(t);store.event(t.id,'approved',`${user.name} 核准計畫 v${version}`);return t;}
export function reviseTask(store,user,tid,answer) {const t=requireTask(store,user,tid);if(!['waiting_input','awaiting_approval','paused','failed'].includes(t.status)) throw new HttpError(409,'請先暫停並等待目前工作結束');if(store.threads(tid).some(x=>x.status==='running'))throw new HttpError(409,'目前工作尚未停止');if(typeof answer!=='string'||answer.trim().length<2||answer.length>8000) throw new HttpError(400,'請輸入 2 至 8000 字的補充');recordClarification(t,store.threads(tid),t.questions||[],answer);t.description+=`\n\n補充需求：${answer.trim()}`;t.outputIssue=null;t.environmentIssue=null;t.userActionRequired=null;t.dependencyPreflight=null;t.validationReviewPending=false;t.planVersion++;t.approvedVersion=null;t.plan=null;t.questions=[];t.status='planning';t.round=0;t.repairPlan=null;t.approvedRepairId=null;t.validationFailure=null;t.error=null;t.retryAt=null;t.retryResumeStatus=null;t.publishApproval=null;store.saveTask(t);store.event(tid,'revised',`需求已更新，重新規劃 v${t.planVersion}`);return t;}

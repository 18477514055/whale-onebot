import { EXPECTED_ACCOUNT, PROTECTED_ACCOUNT, validateParams } from './actions.mjs';
import { normalizeMessage } from './segments.mjs';

// Original translation of the fixed OneBot 11 event quick-operation contract.
// No native/network work here; every returned action uses the normal dispatcher.
export function snapshotQuickContext(event) {
  const value = {};
  for (const key of ['self_id','post_type','message_type','message_id','group_id','user_id','sub_type','request_type','flag'])
    if (Object.hasOwn(event,key)) value[key] = structuredClone(event[key]);
  if (event.anonymous) value.anonymous = structuredClone({id:event.anonymous.id,name:event.anonymous.name,flag:event.anonymous.flag});
  return value;
}

export function planQuickOperations(event, operation) {
  if (!operation || typeof operation!=='object' || Array.isArray(operation)) throw new TypeError('Quick operations must be an object');
  if (String(event.self_id)!==EXPECTED_ACCOUNT || String(event.user_id)===PROTECTED_ACCOUNT) throw new TypeError('Event identity rejected');
  if(['message','request'].includes(event.post_type))validateParams('get_stranger_info',{user_id:event.user_id});
  for (const key of ['auto_escape','at_sender','delete','kick','ban','approve'])
    if (Object.hasOwn(operation,key) && typeof operation[key]!=='boolean') throw new TypeError('Quick-operation boolean required');
  const plan=[];
  const add=(action,params)=>plan.push({action,params:validateParams(action,params)});
  if (event.post_type==='message' && ['private','group'].includes(event.message_type)) {
    if (Object.hasOwn(operation,'reply')) {
      let message=normalizeMessage(operation.reply,operation.auto_escape===true);
      if(!message.length)throw new TypeError('Empty quick reply');
      if (event.message_type==='group') {
        if (operation.at_sender!==false && !event.anonymous)
          message=[{type:'at',data:{qq:String(event.user_id)}},{type:'text',data:{text:' '}},...message];
        add('send_group_msg',{group_id:event.group_id,message});
      } else add('send_private_msg',{user_id:event.user_id,message});
    }
    if (event.message_type==='group') {
      if (operation.delete===true) add('delete_msg',{message_id:event.message_id});
      if (operation.kick===true && !event.anonymous)
        add('set_group_kick',{group_id:event.group_id,user_id:event.user_id,reject_add_request:false});
      if (operation.ban===true) {
        if (event.anonymous) {
          if (typeof event.anonymous.flag!=='string'||!event.anonymous.flag) throw new TypeError('Anonymous flag unavailable');
          add('set_group_anonymous_ban',{group_id:event.group_id,anonymous:event.anonymous,duration:operation.ban_duration??1800});
        } else add('set_group_ban',{group_id:event.group_id,user_id:event.user_id,duration:operation.ban_duration??1800});
      }
    }
  } else if (event.post_type==='request' && Object.hasOwn(operation,'approve')) {
    if (event.request_type==='friend') {
      if (operation.remark!==undefined && (typeof operation.remark!=='string'||operation.remark.length>32768)) throw new TypeError('Invalid remark');
      add('set_friend_add_request',{flag:event.flag,approve:operation.approve,remark:operation.approve?(operation.remark??''):''});
    } else if (event.request_type==='group') {
      if (!['add','invite'].includes(event.sub_type)) throw new TypeError('Invalid group request subtype');
      if (operation.reason!==undefined && (typeof operation.reason!=='string'||operation.reason.length>32768)) throw new TypeError('Invalid reason');
      add('set_group_add_request',{flag:event.flag,sub_type:event.sub_type,approve:operation.approve,reason:operation.approve?'':(operation.reason??'')});
    }
  }
  return plan;
}

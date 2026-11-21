import {readActions} from './social-reads.mjs';
import {writeActions} from './social-writes.mjs';
import {profileActions} from './social-profile.mjs';

export const socialActions = Object.freeze(Object.assign(Object.create(null), readActions, writeActions, profileActions));

// Compatibility facade. Non-QQ workers never load the QQ module or its face files.
import { activePlatformModule } from '../core/platform-modules.js';
const catalog=()=>activePlatformModule().faces;
export const faceNameOf=id=>catalog()?.faceNameOf(id) ?? '';
export const faceIdByName=name=>catalog()?.faceIdByName(name) ?? null;
export const faceNameList=()=>catalog()?.faceNameList() ?? [];
export const refreshFaceCatalog=async client=>catalog()?.refreshFaceCatalog(client) ?? false;
export const resetFaceCatalogForTest=()=>catalog()?.resetFaceCatalogForTest();

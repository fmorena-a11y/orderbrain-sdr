// READ_ONLY=1: qué pedidos escriben en Pipedrive (y se bloquean para probar contra la cuenta real sin tocarla).
// activities/ cubre marcar hecha, deshacer, mover y el resultado de una demo (demo-result, demo-rebook).
// Sin distinguir mayúsculas: Express 4 rutea «/Merge-Orgs» igual que «/merge-orgs».
// mail/ (enviar desde la ficha y su próximo paso): en solo lectura no se manda nada, ni por Gmail ni desde la casilla de
// Pipedrive (createMailDraft/sendMailDraft del MCP; lib/pdmcp.js además se niega solo con READ_ONLY=1). Conectar Pipedrive
// (pegar el token: solo lee users/me), desconectarlo y guardar la firma no escriben datos en Pipedrive: no se bloquean.
// existing («Es este»: puede pasar un prospecto a tu nombre, desarchivarlo o dejar un trato suelto en una organización).
export const PD_WRITE = /^\/api\/(schools\/[^/]+\/(match|existing|merge-orgs|log|comment|prospect|convert|study\/note|enrich|deals\/|persons|archive|unarchive|mail)|activities\/|proposals\/confirm)/i;
export const writesPipedrive = (method, path) => String(method).toUpperCase() === "POST" && PD_WRITE.test(path);

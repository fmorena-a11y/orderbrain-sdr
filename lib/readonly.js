// READ_ONLY=1: qué pedidos escriben en Pipedrive (y se bloquean para probar contra la cuenta real sin tocarla).
// activities/ cubre marcar hecha, deshacer, mover y el resultado de una demo (demo-result, demo-rebook).
// Sin distinguir mayúsculas: Express 4 rutea «/Merge-Orgs» igual que «/merge-orgs».
// mail/ (enviar desde la ficha y su próximo paso): en solo lectura no se manda nada (ni a Gmail ni a Pipedrive).
export const PD_WRITE = /^\/api\/(schools\/[^/]+\/(match|merge-orgs|log|comment|prospect|convert|study\/note|enrich|deals\/|persons|archive|unarchive|mail)|activities\/|proposals\/confirm)/i;
export const writesPipedrive = (method, path) => String(method).toUpperCase() === "POST" && PD_WRITE.test(path);

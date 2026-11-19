// Fachada de la lógica comercial del servidor: reexporta lo público de lib/sales/*.js (un módulo por tema) para que
// server.js, lib/*-api.js, el asistente y las pruebas sigan importando de acá. Los módulos de lib/sales/ se importan
// entre ellos por nombre; el estado compartido (copias en memoria, hooks, recordSources) vive en un solo módulo cada uno.
//  · util: stripHtml, signer · records: fichas que no son de la base (openRecord, ensureRecord, recordSources, hooks)
//  · search: búsqueda en Pipedrive y ficha de persona · match: cruce colegio ↔ organización (checkSchool)
//  · settle: «Antes de crear» (investigate, settleExisting, useExisting…) · link: «Es esta» y fusionar
//  · list: lista y resumen de colegios (schoolList, schoolSummary, effMatch) · detail: ficha y «Qué pasó con OrderEAT»
//  · history: Historial y resumen para la próxima llamada · sedes · enrichment: Enriquecer y campos vacíos del prospecto
//  · contact: Registrar y comentar (logContact, commentSchool, ensureOrg, recordatorios de demo) · mail: mail desde la ficha
//  · worklead: el prospecto donde va lo registrado (workLead) · address: dirección y campos del prospecto nuevo
//  · prospect: crear prospecto, convertir, tratos, archivar y decisor · agenda: agenda, bandeja caliente, cola y ranking
//  · reports: demos, Métricas y «Hoy» del líder
export { signer } from "./sales/util.js";
export { phoneCountry, personLabel, recordSources, hooks, openRecord, ensureRecord } from "./sales/records.js";
export { pdSearch, pdSearchMore, personCard } from "./sales/search.js";
export { checkSchool } from "./sales/match.js";
export { investigate, adoptLead, leadView, settleExisting, useExisting, dismissExisting, namedInPipedrive, leadsHere } from "./sales/settle.js";
export { unlinkSchool, linkSchool, orgPreview, dupesFor, mergeOrgs } from "./sales/link.js";
export { potentialFor, schoolListItem, schoolList, schoolSummary } from "./sales/list.js";
export { askFor, schoolDetail, draftContext, historyFor } from "./sales/detail.js";
export { dropTimeline, timelineFor, callBriefFor } from "./sales/history.js";
export { splitPhones, splitMails, sedesFor } from "./sales/sedes.js";
export { getEnrich, enrichSchool, leadGaps } from "./sales/enrichment.js";
export { ensureOrg, nextFor, askOf, noteRows, reminderPlan, demoReminder, demoMoved, whereOf, logContact, commentSchool } from "./sales/contact.js";
export { mailActivitySubject, mailGuard, sendMail, mailNext } from "./sales/mail.js";
export { pickContactLead, clientNow, exClientNow, workLead, openLeadFor, ENRICH_WAIT, enrichNewLead, markWorked } from "./sales/worklead.js";
export { cleanPhoneVal, cleanMailVal, addressView, setAddress, addrLine, leadFields } from "./sales/address.js";
export { createProspect, convertToDeal, dealAction, archiveSchool, unarchiveSchool, addDecisor } from "./sales/prospect.js";
export { eventOf, withoutEvent, archivedRef, myActivities, freshLeads, newForMe, prospectQueue, stateOf, scoreFor, stats, teamFeed } from "./sales/agenda.js";
export { demosMonth, metricsDemos, metricsDeals, ACT_PAGES, metricsActivity, leadActs, leadDemos, metricsInbound, metricsContacts, metricsArchived, markDemo, rebookDemo } from "./sales/reports.js";
export { OUTCOMES } from "./playbook.js";
export { allMatches } from "./store.js";

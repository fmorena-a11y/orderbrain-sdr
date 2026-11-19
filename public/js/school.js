// Ficha del colegio: preparar el contacto, registrar el resultado e historial. Incluye el modo sesión.
// Fachada: reexporta lo que usan las vistas; el código está partido por tema en public/js/school/ (el estado de la ficha,
// D, vive en state.js y lo comparten todos):
//  · state: D, constantes y formulario · open: abrir y cerrar la ficha, dirección, pausa de la sesión, carga
//  · media: de la base cargada, estudio, fotos · sections: «Qué pasó con OrderEAT», tratos y decisor, Enriquecer, sedes
//  · session: modo sesión (avanzar, saltear, adelantar estudios) · render: dibujo, pestañas, crear prospecto, archivar
//  · prep: Preparar, «Ya hay algo parecido en Pipedrive», «Es esta» y fusionar · register: Registrar y atajos de teclado
//  · history: Historial, resumen para la próxima llamada, tu trato · messages: WhatsApp y mail con plantillas
export { drawerOpen, currentSchoolId } from "./school/state.js";
export { openRecord, openSchool, closeSchool, resumeSession, prefetchFirst } from "./school/open.js";
export { useSession, startSession } from "./school/session.js";

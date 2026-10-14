import { db } from '../src/db';
import { actionSuggestions, evaluations, contents, projects, projectSnapshots } from '../src/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getCurrentVaultPath } from '../src/vault/config';
import { reconcileAllProjects } from '../src/vault/reconciler';
import { evaluateContentMatch } from '../src/evaluator';
import * as path from 'path';

async function main() {
  console.log('====================================================================');
  console.log('       LOOM — RECONCILIACIÓN Y REEVALUACIÓN DE CONTENIDOS');
  console.log('====================================================================\n');

  const vaultPath = getCurrentVaultPath();
  if (!vaultPath) {
    console.error('Error: VAULT_PATH no está configurado.');
    process.exit(1);
  }

  // 1. Limpiar evaluaciones antiguas y sugerencias pendientes
  console.log('[1/4] Limpiando evaluaciones previas y sugerencias pendientes...');
  await db.delete(actionSuggestions).where(eq(actionSuggestions.status, 'pending'));
  await db.delete(evaluations);
  console.log('[OK] Tablas de evaluaciones limpias.');

  // 2. Regenerar snapshot del proyecto (leyendo todos los .md)
  console.log('\n[2/4] Regenerando snapshot del proyecto (agregando todos los .md)...');
  await reconcileAllProjects(vaultPath, true);

  const activeProjects = await db.select().from(projects).where(eq(projects.isActive, true));
  if (activeProjects.length === 0) {
    console.error('No se encontraron proyectos activos.');
    process.exit(1);
  }

  for (const proj of activeProjects) {
    const [latestSnapshot] = await db.select()
      .from(projectSnapshots)
      .where(eq(projectSnapshots.projectId, proj.id))
      .orderBy(desc(projectSnapshots.capturedAt))
      .limit(1);

    console.log(`[Snapshot Generado] Proyecto: "${proj.title}"`);
    console.log(` - Notas incluidas:`, latestSnapshot?.noteTitles);
    console.log(` - Tesis limpia (UI): "${latestSnapshot?.thesisText}"`);
    console.log(` - Longitud notas de apoyo: ${latestSnapshot?.notesContent?.length || 0} caracteres`);
  }

  // 3. Obtener todos los contenidos listos
  const readyContents = await db.select()
    .from(contents)
    .where(eq(contents.ingestStatus, 'ready'));

  console.log(`\n[3/4] Reevaluando ${readyContents.length} contenidos procesados contra el nuevo contexto...`);

  // 4. Ejecutar evaluación para cada contenido
  for (let i = 0; i < readyContents.length; i++) {
    const item = readyContents[i];
    console.log(`\n--- Evaluando [${i + 1}/${readyContents.length}]: "${item.title}" ---`);
    await evaluateContentMatch(item.id);
  }

  // Resumen final
  console.log('\n====================================================================');
  console.log('                 RESUMEN DE RESULTADOS DE TRIAJE');
  console.log('====================================================================');

  const newEvals = await db.select().from(evaluations);
  console.log(`Total Evaluaciones generadas: ${newEvals.length}`);
  for (const ev of newEvals) {
    const [cnt] = await db.select().from(contents).where(eq(contents.id, ev.contentId));
    console.log(` - [${(ev.verdict || 'unknown').toUpperCase()}] (${Math.round((ev.confidenceScore || 0) * 100)}%): "${cnt?.title}"`);
  }

  const newSugs = await db.select().from(actionSuggestions);
  console.log(`\nTotal Sugerencias de Acción generadas: ${newSugs.length}`);
  for (const sug of newSugs) {
    console.log(` * [${sug.actionType}]: "${sug.suggestedAction.substring(0, 100)}..."`);
  }

  console.log('\n[OK] Reevaluación completada con éxito.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error fatal durante la reevaluación:', err);
  process.exit(1);
});

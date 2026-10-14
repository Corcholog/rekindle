import { db } from '../src/db';
import { projects, projectSnapshots, contents, evaluations, actionSuggestions } from '../src/db/schema';
import * as fs from 'fs/promises';
import * as path from 'path';

async function seedDemo() {
  console.log('Seeding demo data for UI inspection...');

  // Setup local demo vault
  const vaultPath = path.resolve(process.cwd(), 'demo_vault');
  const projectDir = path.join(vaultPath, 'Projects', 'Agentes_Autonomos');
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, 'project.md'),
    `---
tags:
  - project
---
# Proyecto: Agentes Autónomos
Investigación y desarrollo de agentes autónomos guiados por LLMs y arquitecturas de eventos.
`
  );

  // Clean demo suggestions.md so it starts fresh without leftover test entries
  const suggestionsFile = path.join(projectDir, 'suggestions.md');
  await fs.rm(suggestionsFile, { force: true }).catch(() => {});

  // Clean existing data
  await db.delete(actionSuggestions);
  await db.delete(evaluations);
  await db.delete(projectSnapshots);
  await db.delete(projects);
  await db.delete(contents);

  // 1. Projects
  const [proj1] = await db.insert(projects).values({
    folderPath: 'Projects/Agentes_Autonomos',
    title: 'Agentes Autónomos',
    currentHash: 'hash_demo_1',
    isActive: true,
  }).returning();

  const [proj2] = await db.insert(projects).values({
    folderPath: 'Projects/Arquitectura_Distribuida',
    title: 'Arquitectura Distribuida',
    currentHash: 'hash_demo_2',
    isActive: true,
  }).returning();

  // 2. Project Snapshots
  const [snap1] = await db.insert(projectSnapshots).values({
    projectId: proj1.id,
    treeHash: 'tree_1',
    thesisText: 'Explorar sistemas multi-agente descentralizados con comunicación pub/sub reactiva.',
    noteTitles: ['project.md', 'arquitectura.md'],
  }).returning();

  // 3. Content 1: Ready content
  const [content1] = await db.insert(contents).values({
    uri: 'https://techblog.com/pub-sub-agentes-ia',
    title: 'Patrones Pub/Sub y Sistemas de Agentes Autónomos',
    rawText: 'Análisis detallado sobre cómo desacoplar agentes mediante colas de mensajes distribuidas...',
    summary: 'El artículo explica cómo los patrones de mensajería asíncrona reducen la latencia y evitan cuellos de botella en ecosistemas de agentes concurrentes.',
    ingestStatus: 'ready',
    consumptionSeq: 1,
  }).returning();

  // Content 2: In-flight / Extracting content
  await db.insert(contents).values({
    uri: 'https://arxiv.org/abs/2403.11111',
    title: 'Constitutional AI and Self-Correction Mechanisms',
    ingestStatus: 'extracting',
    consumptionSeq: 1,
  });

  // Content 3: Failed content
  await db.insert(contents).values({
    uri: 'https://servidor-inexistente.dev/articulo-perdido',
    title: 'Servidor no disponible',
    ingestStatus: 'failed',
    ingestStatusReason: 'Error de conexión HTTP: 404 No encontrado',
    consumptionSeq: 1,
  });

  // 4. Evaluations
  const [eval1] = await db.insert(evaluations).values({
    contentId: content1.id,
    projectSnapshotId: snap1.id,
    verdict: 'actionable',
    confidenceScore: 0.94,
    triageReasoning: 'El artículo coincide directamente con la tesis del proyecto al proponer brokers Pub/Sub para coordinar agentes sin bloqueo mutuo.',
    consumptionSeq: 1,
  }).returning();

  // 5. Suggestions
  // 5a. Pending suggestion
  await db.insert(actionSuggestions).values({
    evaluationId: eval1.id,
    projectId: proj1.id,
    contentId: content1.id,
    actionType: 'evidence_citation',
    customTypeLabel: 'Cita de evidencia',
    targetFile: 'Projects/Agentes_Autonomos/arquitectura.md',
    targetSection: '## Comunicación Inter-Agente',
    observation: 'El texto valida la arquitectura basada en eventos y brokers distribuidos.',
    suggestedAction: 'Citar las conclusiones de la sección 3 para fundamentar la selección de RabbitMQ o NATS.',
    sourceReference: 'https://techblog.com/pub-sub-agentes-ia',
    status: 'pending',
    writtenToVault: false,
  });

  // 5b. Pending counterargument suggestion
  await db.insert(actionSuggestions).values({
    evaluationId: eval1.id,
    projectId: proj1.id,
    contentId: content1.id,
    actionType: 'counter_argument',
    customTypeLabel: 'Contraargumento',
    targetFile: 'Projects/Agentes_Autonomos/riesgos.md',
    targetSection: '## Riesgos de consistencia',
    observation: 'Señala que los eventos eventuales pueden provocar estados inconsistentes en agentes de trading.',
    suggestedAction: 'Añadir una advertencia en la sección de riesgos sobre consistencia eventual y particiones de red.',
    sourceReference: 'https://techblog.com/pub-sub-agentes-ia',
    status: 'pending',
    writtenToVault: false,
  });

  console.log('Demo seed completed successfully!');
  console.log('Vault path:', vaultPath);
  process.exit(0);
}

seedDemo().catch(err => {
  console.error('Seed demo error:', err);
  process.exit(1);
});

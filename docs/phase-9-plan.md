# Fase 9 — plano de release v0.1

Autoridade: [Fase 9 — Release v0.1](https://www.notion.so/3d251cfc265c81aca312eb1cd5026b07)
e [PRD Validation & Release](https://www.notion.so/3d251cfc265c814d86e1df25ff45e238),
seção Fase 9, VR-REL-001–008 e Definition of Done.

Estado: **preparação iniciada**. A integração da fase 8 preserva o candidato
validado e seus consumidores externos. O pacote permanece `@lilka/vane@0.0.0`,
`private: true`; nenhum RC, tag de release ou publicação é produzido por este plano.

## Gate de entrada e baseline

- Fases 7 e 8 validadas: [conformance](conformance.md) e
  [aceite dos três dogfoods](phase-8-completion.md).
- Candidato validado: commit `12ee6a1182f7c6750e02cf3cf6dd4a3b5663ac2e`,
  tarball SHA-256 `786c90654e9430cb32233d2b7647656c09a8cf8a2bbae54de2b1d2a6cf5ce043`.
- CI da main deve concluir verde, incluindo o novo workflow de consumidores externos.
- O runtime validado usa Node 24.19.0 e PostgreSQL 16.15; `engines >=24` atual
  precisa ser reconciliado com a política de suporte que será publicada.
- Logs de adoção aceitam P2 explícitos; não constituem revisão de segurança do RC.

## Fases, tasks e dependências

| Task | Trabalho concreto | Evidência de conclusão | Dependência / requisito |
| --- | --- | --- | --- |
| R9-A1 | Confirmar CI remoto e identificar commit baseline; preservar relatório e hashes | CI verde, SHA de commit/tree/tarball e manifest | Entrada; VR-REL-007/008 |
| R9-A2 | Confirmar nome `@lilka/vane`, registry, ownership do scope e mecanismo de publicação CI | Permissão de publish verificada sem expor credenciais; política de tags npm | A1; pré-requisito externo para RC |
| R9-B1 | Inventariar exports de valor/tipo e CLI; classificar API suportada, experimental e operacional privilegiada | Manifest versionado, snapshot automatizado e revisão de vazamento de internals | A1; VR-REL-004 |
| R9-B2 | Documentar compatibilidade durante 0.x, deprecações e suporte Node/PostgreSQL | Política vinculada a APIs e ambientes realmente testados | B1; VR-REL-004/005 |
| R9-C1 | Revisar erros HTTP/SSE, logs, telemetria e persistência contra vazamento de secrets | Testes com sentinelas falsas, inventário de campos sensíveis e relatório redaction | A1; VR-REL-006 |
| R9-C2 | Revisar auth/ACL boundaries, inspeção privilegiada, failure queue, retry, retenção e at-least-once | Revisão operacional e casos negativos; idempotência externa documentada | C1; VR-REL-005/006/008 |
| R9-C3 | Auditar dependências, conteúdos empacotados e supply chain | Audit triado, lista de arquivos/licenças e zero finding crítico/alto sem decisão explícita | A1; VR-REL-006/008 |
| R9-D1 | Preparar `0.1.0-rc.1`: remover private, sincronizar lockfile, revisar exports/types/bin/files/license/engines | Metadata coerente e dry-run de pack/publish com conteúdo aprovado | B1/B2/C1–C3; VR-REL-001/002 |
| R9-D2 | Empacotar duas vezes em checkouts limpos do mesmo commit; comparar bytes | Hashes idênticos e manifest commit/tree/package/docs | D1; VR-REL-007 |
| R9-D3 | Instalar RC empacotado em consumidores limpos; renovar locks; provar install/upgrade | Tipos/build/CLI/runtime, migração pré-RC→RC e restart sem drift; original baseline preservada | D2; VR-REL-003 |
| R9-D4 | Escrever changelog, release notes, quickstart e limites operacionais do RC | Docs correspondem ao pacote; P2 explícitos e links de evidência | B2/C2/D3; VR-REL-005 |
| R9-E1 | Executar CI completa, conformance 100% obrigatória e três dogfoods no mesmo RC | Relatórios atuais sem FAIL/GAP, mesma identidade; 50+50 corridas e crashes reais | D3/D4; VR-REL-003/008 |
| R9-E2 | Publicar RC e tag identificada; instalar o RC obtido do registry | `0.1.0-rc.1`, dist-tag de pré-release, integridade registry e release notes | A2/E1; VR-REL-001/002/007 |
| R9-E3 | Fazer rodada explícita de revisão API/docs/security do RC publicado | Parecer registrado; findings corrigidos ou decisões explícitas; re-gate para qualquer mudança | E2; gate RC do PRD |
| R9-F1 | Preparar `0.1.0`, lockfile e docs finais; revalidar artefato GA | Pack limpo, install/upgrade externo, CI/conformance/dogfood/security verdes no GA | E3; VR-REL-002/003/007/008 |
| R9-F2 | Publicar GA, ajustar dist-tag e criar tag/release que identifica o pacote exato | Registry integrity, commit/tag, hashes, manifest e notas finais concordam | F1; VR-REL-007/008 |

A API e a revisão de segurança podem avançar em paralelo após A1. Empacotamento
do RC depende de ambas. RC publicado precede revisão explícita e promoção GA.
Uma alteração de versão muda o tarball: resultados antigos não são transferidos
para RC/GA por similaridade do código.

## Preparação atual e insumos pendentes

- [x] Especificação e VR-REL-001–008 localizados no Notion.
- [x] Plano sequenciado e evidências obrigatórias definidos.
- [x] Candidato validado e consumidores/evidências preservados na main.
- [x] Workflow externo preparado para executar o tarball da revisão atual.
- [ ] R9-A1: confirmar CI remoto desta integração.
- [ ] R9-A2: obter readiness de publicação npm; autenticação GitHub não prova ownership npm.
- [ ] B–F: executar os trabalhos e gates acima.

`private: true`, versão `0.0.0` e ausência de manifest de API congelado são tarefas
de release ainda abertas. Os P2 da fase 8 (help exit 1, normalização de CHECK,
volatilidade Moto e padrão específico de CAS/clock) precisam de disposição
explícita no RC e release notes. Não há credenciais npm/AWS declaradas no ambiente
gerenciado atual; publicação deve usar o mecanismo autorizado do registry.
AWS smoke permanece opt-in e só será necessário para garantia crítica que Moto
não consiga validar. O fluxo básico não adquire nova dependência de AWS real.

## Gate de saída

Todos os oito VR-REL precisam de evidência. GA exige: package público, SemVer
coerente, API manifest verificável, install/upgrade externo, changelog e limites,
ausência de vazamento de secrets, reprodução por commit/tag, zero P0/P1,
nenhum finding crítico/alto sem decisão explícita, conformance obrigatória 100%,
três dogfoods verdes, revisão explícita do RC e nenhuma decisão conceitual pendente.

Runtime distribuído, novos bancos/transports e harness genérico permanecem fora
deste ciclo conforme o PRD. A próxima execução começa por **R9-A1/A2 e B1/C1**.

-- =============================================================================
-- Tourniquet · 98 · Job: cierre de sesiones vencidas
-- MOTOR: SQL Server
--
-- QUE HACE
--   `UPDATE tok_sesion SET cerrada_en = expira_en, motivo_cierre = 'expirada'`
--   para las sesiones que vencieron y siguen con `cerrada_en IS NULL`.
--
-- POR QUE MARCA Y NO BORRA
--   `tok_sesion` es append-only con revocacion (invariante de `AGENTS.md`): las
--   sesiones no se borran, se cierran. Un `DELETE` de aca seria la forma corta de
--   revocar tokens sin dejar rastro, y ademas dejaria `tok_refresh_token` con FK
--   `ON DELETE NO ACTION` apuntando a filas que ya no existen.
--
--   Y por que hace falta el job si las consultas ya filtran por `expira_en`:
--   porque sin el, `tok_sesion` es la unica tabla que **crece sin limite** de este
--   repo (los codes se limpian, los refresh se limpian, la auditoria se retiene, y
--   las sesiones nunca se borran). El job no cambia lo que la app ve --las sesiones
--   vencidas no salen en ningun listado--: escribe el `motivo='expirada'` que
--   hace falta para distinguir "esta sesion se cerro porque alguien salio" de "esta
--   sesion se murio sola", y deja de crecer la tabla.
--
-- `cerrada_en = expira_en` Y NO `sysutcdatetime()`
--   La sesion no se cerro ahora: se cerro cuando vencio. Poner la hora de corrida
--   del job haria que un login del panel que expiro hace tres horas pareciera
--   cerrado hace tres horas, y en la investigacion "cuando se cerro esta sesion" la
--   respuesta seria mentira. `cerrada_en` es un hecho de la fila, no del job.
--
-- LAS SESIONES CON `cerrada_en` YA PUESTO NO SE TOCAN
--   El filtro es `cerrada_en IS NULL`, asi que una sesion cerrada por logout, por
--   revocacion del panel o por `replay` conserva su `cerrada_en` y su motivo. El
--   job no pisa el motivo de un cierre que ya ocurrio.
--
-- IDEMPOTENCIA
--   Es un `UPDATE` cuyo filtro es "cerrada_en IS NULL": la segunda corrida no
--   encuentra filas y no cambia nada. Se puede correr cada hora sin miedo.
--
-- QUIEN LO EJECUTA
--   El USUARIO, cada hora. SQL Agent, o Planificador de tareas +
--   `deploy/jobs/ejecutar-jobs.cmd` si el motor es SQL Server Express.
--   Ver `deploy/runbooks/jobs-limpieza.md`.
--
--   Con `sqlcmd`: `sqlcmd -S <srv> -d tourniquet -b -i 98-job-sesiones.sql`
--
-- ROLLBACK
--   Parcial y por SQL, a mano: `UPDATE tok_sesion SET cerrada_en = NULL,
--   motivo_cierre = NULL WHERE cerrada_en = expira_en AND motivo_cierre =
--   'expirada'`. **No** es necesario en la practica: reabrir una sesion vencida no
--   la revive (el `sid` sigue vencido por `expira_en`) y confunde la lectura de la
--   tabla. Se documenta para que el rollback exista y para que quede claro que es
--   un acto refleja, no una operacion de negocio.
-- =============================================================================


SET NOCOUNT ON;
GO

PRINT N'-- ===========================================';
PRINT N'-- 98 · Job: cierre de sesiones vencidas (marca, no borra)';
PRINT N'-- Frecuencia: cada hora';
PRINT N'-- ===========================================';
GO


-- -----------------------------------------------------------------------------
-- 1 · Conteo previo, separado por lo que el job hace y lo que no
--
-- Se cuentan las abiertas y vencidas (a cerrar), las abiertas y vigentes (no se
-- tocan) y las cerradas por una persona (tampoco: son el motivo de ser de la
-- columna). Las tres cifras antes y despues son la verificacion de que el filtro
-- no se corrio un caracter.
-- -----------------------------------------------------------------------------
DECLARE @aCerrar INT = (
    SELECT COUNT(*) FROM dbo.tok_sesion
    WHERE cerrada_en IS NULL AND expira_en <= sysutcdatetime());

DECLARE @abiertasVigentes INT = (
    SELECT COUNT(*) FROM dbo.tok_sesion
    WHERE cerrada_en IS NULL AND expira_en > sysutcdatetime());

DECLARE @cerradasPorPersona INT = (
    SELECT COUNT(*) FROM dbo.tok_sesion
    WHERE cerrada_en IS NOT NULL
      AND motivo_cierre IN (N'soporte', N'sospecha', N'reemplazo',
                            N'solicitud_del_usuario', N'otro'));

PRINT N'-- Antes: abiertas y vencidas (a cerrar)   = ' + CAST(@aCerrar AS NVARCHAR(10));
PRINT N'-- Antes: abiertas y vigentes (intocables) = ' + CAST(@abiertasVigentes AS NVARCHAR(10));
PRINT N'-- Antes: cerradas por una persona         = ' + CAST(@cerradasPorPersona AS NVARCHAR(10));
GO


-- -----------------------------------------------------------------------------
-- 2 · El UPDATE
--
-- El `motivo_cierre = N'expirada'` esta en la lista cerrada del CHECK de
-- `tok_sesion.motivo_cierre` (`specs/02` §3), y por eso no necesita `WITH
-- CHECK` ni ninguna comprobacion: si el valor no estuviera en la lista, el
-- motor rechazaria el UPDATE entero, que es el comportamiento que se quiere.
-- -----------------------------------------------------------------------------
UPDATE dbo.tok_sesion
SET cerrada_en    = expira_en,
    motivo_cierre = N'expirada'
WHERE cerrada_en IS NULL
  AND expira_en <= sysutcdatetime();
GO


-- =============================================================================
-- 3 · Verificacion
-- =============================================================================
PRINT N'';
PRINT N'--- VERIFICACION · 98 · Job de sesiones ---';
PRINT N'';

PRINT N'--- 1 · Conteo posterior (tiene que dar 0) ---';
SELECT
    (SELECT COUNT(*) FROM dbo.tok_sesion
        WHERE cerrada_en IS NULL AND expira_en <= sysutcdatetime())  AS abiertas_vencidas_restantes;
GO

PRINT N'--- 2 · Lo que NO se toco (estas cifras tienen que ser IGUALES a las de antes) ---';
SELECT
    (SELECT COUNT(*) FROM dbo.tok_sesion
        WHERE cerrada_en IS NULL AND expira_en > sysutcdatetime())   AS abiertas_vigentes,
    (SELECT COUNT(*) FROM dbo.tok_sesion
        WHERE motivo_cierre IN (N'soporte', N'sospecha', N'reemplazo',
                                N'solicitud_del_usuario', N'otro'))  AS cerradas_por_persona;
GO

PRINT N'--- 3 · Reparto de motivos (historia de la tabla) ---';
PRINT N'-- Las cuatro filas tecnicas mas las cinco del panel: si aparece un valor';
PRINT N'-- raro, hay una escritura a mano que no paso por el CHECK... o el CHECK';
PRINT N'-- se creo con NOCHECK. La siguiente consulta lo dice.';
SELECT
    ISNULL(motivo_cierre, N'(abierta)')  AS motivo,
    COUNT(*)                             AS sesiones
FROM dbo.tok_sesion
GROUP BY motivo_cierre
ORDER BY sesiones DESC;
GO

PRINT N'--- 4 · El CHECK de motivos, y si valida las filas que ya estaban ---';
SELECT
    cc.name                                                          AS constraint_,
    REPLACE(REPLACE(cc.definition, N'[', N''), N']', N'')            AS definicion,
    CASE WHEN cc.is_not_trusted = 1
         THEN N'NO VALIDA LAS FILAS EXISTENTES (se creo con NOCHECK)'
         ELSE N'confiable' END                                        AS confianza
FROM sys.check_constraints cc
WHERE cc.name = N'CK_tok_sesion_motivo';
GO

PRINT N'-- 98 listo.';
GO

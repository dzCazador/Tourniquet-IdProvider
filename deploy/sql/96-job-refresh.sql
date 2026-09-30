-- =============================================================================
-- Tourniquet · 96 · Job: limpieza de refresh tokens revocados
-- MOTOR: SQL Server
--
-- QUE HACE
--   `DELETE FROM tok_refresh_token WHERE revocado_en < now - 90 dias`.
--
-- POR QUE "REVOCADOS" Y NO "VENCIDOS"
--   Es la distincion que hace que este job no destruya evidencia:
--
--   - Un refresh **revocado** (`revocado_en` con fecha) es un refresh que ya no
--     sirve para nada: la sesion esta cerrada o la familia se revo. La fila solo
--     sirve para el diagnostico, y 90 dias son de sobra.
--   - Un refresh que **expiro** sin revocarse (`expira_en` en el pasado,
--     `revocado_en IS NULL`) se CONSERVA mientras la sesion siga viva, que es
--     exactamente lo que dice `specs/01` §7.1.
--
--   Y el motivo por el que borrar los vencidos seria un error de verdad: la
--   deteccion de `replay` (reuso de un token ya rotado) se hace justamente contra
--   la fila del token viejo. Si el job borrara los tokens por fecha de expiracion,
--   la familia de un robo tendria menos evidencia a medida que pasan los dias, y
--   el incidente se investigaria con menos datos que el dia que paso.
--
--   Ojo con el indice `IX_tok_refresh_token_expira`, que es FILTRADO
--   (`WHERE revocado_en IS NULL`): sirve para "refrescos vivos", que es la consulta
--   de la app. Este DELETE va por `revocado_en`, que es otra columna, y por eso no
--   lo cubre. Con una tabla de esta escala el recorrido secuencial es tolerable y
--   agregar un indice por `revocado_en` seria optimizar una consulta mensual: se
--   deja asi a proposito, y el numero de filas que deja de crecer es la medida.
--
--   Si alguna vez la tabla pasa de cientos de miles de filas y el job se nota,
--   el indice que corresponde es `IX_tok_refresh_token_revocado (revocado_en)`, y
--   va en un incremental NUEVO (el siguiente numero libre) y en el
--   `00-crear-base.sql`. No se agrega a este archivo: un job de retencion que
--   tambien crea indices es un job que alguna vez los crea en el momento
--   equivocado.
--
-- IDEMPOTENCIA
--   Es un `DELETE` con filtro de fecha: correrlo dos veces borra cero la segunda
--   vez y no falla.
--
-- QUIEN LO EJECUTA
--   El USUARIO, una vez por dia (de madrugada). SQL Agent, o Planificador de tareas
--   + `deploy/jobs/ejecutar-jobs.cmd` si el motor es SQL Server Express.
--   Ver `deploy/runbooks/jobs-limpieza.md`.
--
--   Con `sqlcmd`: `sqlcmd -S <srv> -d tourniquet -b -i 96-job-refresh.sql`
--
-- ROLLBACK
--   No aplica. Lo unico irreversible es que un refresh revocado hace 90 dias no se
--   puede volver a ver; nadie lo necesita para volver a entrar, porque la sesion
--   que lo emitio esta cerrada.
-- =============================================================================


SET NOCOUNT ON;
GO

PRINT N'-- ===========================================';
PRINT N'-- 96 · Job: refresh tokens revocados (retention 90 dias)';
PRINT N'-- Frecuencia: diaria';
PRINT N'-- ===========================================';
GO


-- -----------------------------------------------------------------------------
-- 1 · Conteo previo, en las tres categorias que el job NO debe tocar
--
-- Se cuentan los revocados viejos (los que se van a borrar) y, al lado, los
-- revocados recientes y los vencidos sin revocar (los que se quedan). Las tres
-- cifras juntas son las que dicen si el filtro esta bien: un job que borrara
-- 8000 filas cuando hay 40 revocados viejos esta leyendo otra columna.
-- -----------------------------------------------------------------------------
DECLARE @porBorrar INT = (
    SELECT COUNT(*) FROM dbo.tok_refresh_token
    WHERE revocado_en IS NOT NULL
      AND revocado_en < DATEADD(day, -90, sysutcdatetime()));

DECLARE @revocadosRecientes INT = (
    SELECT COUNT(*) FROM dbo.tok_refresh_token
    WHERE revocado_en IS NOT NULL
      AND revocado_en >= DATEADD(day, -90, sysutcdatetime()));

DECLARE @vencidosSinRevocar INT = (
    SELECT COUNT(*) FROM dbo.tok_refresh_token
    WHERE revocado_en IS NULL
      AND expira_en < sysutcdatetime());

PRINT N'-- Antes: revocados de mas de 90 dias (a borrar) = ' + CAST(@porBorrar AS NVARCHAR(10));
PRINT N'-- Antes: revocados recientes (se conservan)     = ' + CAST(@revocadosRecientes AS NVARCHAR(10));
PRINT N'-- Antes: vencidos sin revocar (se conservan)    = ' + CAST(@vencidosSinRevocar AS NVARCHAR(10));
GO


-- -----------------------------------------------------------------------------
-- 2 · El DELETE
--
-- El `revocado_en IS NOT NULL` esta **dentro** del filtro y no es redundante: sin
-- el, los NULL comparan como menores que cualquier fecha y el job borraria
-- todos los refreshes vivos de las sesiones abiertas. Es el error clasico de este
-- tipo de job, y por eso la condicion aparece explicita y no abreviada.
-- -----------------------------------------------------------------------------
DELETE FROM dbo.tok_refresh_token
WHERE revocado_en IS NOT NULL
  AND revocado_en < DATEADD(day, -90, sysutcdatetime());
GO


-- =============================================================================
-- 3 · Verificacion
-- =============================================================================
PRINT N'';
PRINT N'--- VERIFICACION · 96 · Job de refresh tokens ---';
PRINT N'';

PRINT N'--- 1 · Conteo posterior (tiene que dar 0) ---';
SELECT
    (SELECT COUNT(*) FROM dbo.tok_refresh_token
        WHERE revocado_en IS NOT NULL
          AND revocado_en < DATEADD(day, -90, sysutcdatetime()))  AS revocados_viejos_restantes;
GO

PRINT N'--- 2 · Lo que NO se toco: estas cifras tienen que ser IGUALES a las de antes ---';
SELECT
    (SELECT COUNT(*) FROM dbo.tok_refresh_token
        WHERE revocado_en IS NULL)                                  AS refresh_vivos,
    (SELECT COUNT(*) FROM dbo.tok_refresh_token
        WHERE revocado_en IS NOT NULL
          AND revocado_en >= DATEADD(day, -90, sysutcdatetime()))   AS revocados_recientes,
    -- La comprobacion que de verdad importa: los refreshes de las sesiones
    -- abiertas siguen ahi. Si este numero baja despues de correr el job, el
    -- filtro esta mal.
    (SELECT COUNT(*) FROM dbo.tok_refresh_token
        WHERE revocado_en IS NULL
          AND expira_en < sysutcdatetime())                        AS vencidos_sin_revocar;
GO

PRINT N'-- 96 listo.';
GO

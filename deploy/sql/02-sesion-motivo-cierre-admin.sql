-- =============================================================================
-- Tourniquet · 02 · tok_sesion.motivo_cierre: los motivos del panel
-- MOTOR: SQL Server
--
-- QUE CAMBIA
--   1. `dbo.tok_sesion.motivo_cierre` de nvarchar(20) a nvarchar(30).
--   2. La lista cerrada de `CK_tok_sesion_motivo`, que pasa de cuatro valores a
--      nueve: se le agregan `soporte`, `sospecha`, `reemplazo`,
--      `solicitud_del_usuario` y `otro`.
--
-- POR QUE
--   La Fase 08 cierra sesiones de usuarios desde el panel de `admin_identidad`, y el
--   motivo es **obligatorio** (`fase-08` §5): un cierre de sesión sin explicación es
--   indistinguible de un abuso, y el motivo es justo lo que se mira investigando un
--   acceso. Con el CHECK de cuatro valores no hay dónde ponerlo: el panel tendría que
--   mentir y escribir `revocada`.
--
--   La alternativa de NO tocar el esquema —dejar `revocada` y guardar el motivo solo
--   en `aud_login.detalle`— se descarta por una razón práctica: `tok_sesion` es lo
--   que se consulta cuando alguien pregunta "por qué esta sesión está cerrada", y
--   el motivo en una tabla de auditoría de texto libre obliga a saber que hay que
--   ir a buscarlo. El motivo de una persona es un dato de la sesión, no de un log.
--
--   El ancho **no** era opcional: `solicitud_del_usuario` son 21 caracteres y la
--   columna era nvarchar(20). Con el CHECK nuevo y la columna vieja, el INSERT del
--   panel fallia con "el valor de tipo nvarchar excede la longitud" en el momento
--   de escribir, que es el peor momento para descubrir un problema de esquema.
--   Los dos cambios (ancho y lista) van en el mismo archivo porque son el mismo
--   cambio: la lista de motivos.
--
-- AFECTA
--   dbo.tok_sesion: el tipo de `motivo_cierre` (nvarchar(20) -> nvarchar(30)) y la
--   constraint CK_tok_sesion_motivo. **Ninguna** otra tabla.
--
--   OJO con `tok_refresh_token.motivo`, que **NO** se toca: es el motivo a nivel
--   token y tiene su propia lista, con `rotado` y `reemplazado` que no son cierres de
--   sesión. Cuando el panel fuerza un cierre, la familia de refresh se revoca con
--   `revocada` y el motivo humano queda en la sesión y en `aud_login.detalle`
--   (`specs/02` §3). Ensuciar esa lista con valores de panel haría que "por qué
--   murió este refresh" dejara de tener respuesta.
--
-- ROLLBACK
--   ALTER TABLE dbo.tok_sesion WITH NOCHECK
--       DROP CONSTRAINT CK_tok_sesion_motivo;
--   ALTER TABLE dbo.tok_sesion WITH NOCHECK
--       ADD CONSTRAINT CK_tok_sesion_motivo
--       CHECK (motivo_cierre IN (N'logout', N'revocada', N'replay', N'expirada'));
--   ALTER TABLE dbo.tok_sesion ALTER COLUMN motivo_cierre nvarchar(20) NULL;
--   (el CHECK con `WITH NOCHECK` porque puede haber filas con motivos del panel: el
--   rollback deja esas filas como estan y solo deja de validar las nuevas. El
--   `ALTER COLUMN` de Narrowing solo falla si alguna fila NO cabe en 20, o sea si
--   quedo un motivo del panel escrito: en ese caso el rollback se detiene y hay que
--   decidir que hacer con esas filas antes de seguir.)
-- =============================================================================


SET NOCOUNT ON;
GO

PRINT N'-- ===========================================';
PRINT N'-- 02 · tok_sesion.motivo_cierre: los cinco motivos del panel';
PRINT N'-- AFECTA: CK_tok_sesion_motivo (dbo.tok_sesion)';
PRINT N'-- ROLLBACK: en la cabecera de este archivo';
PRINT N'-- ===========================================';
GO


-- -----------------------------------------------------------------------------
-- 1 · Ampliar la columna
--
-- Primero el ancho, despues la lista. Al reves el ALTER del ancho sigue funcionando
-- (ampliar no invalida nada), pero el orden asi deja el log del script contando la
-- historia: "primero que la columna admita el motivo, despues que el motivo sea legal".
--
-- Es idempotente: si ya es nvarchar(30) (o mas ancha) no hace nada, asi que el
-- script se puede correr las veces que haga falta.
-- -----------------------------------------------------------------------------
DECLARE @anchoActual int = (
    SELECT c.max_length / 2
    FROM sys.columns c
    WHERE c.object_id = OBJECT_ID(N'dbo.tok_sesion')
      AND c.name = N'motivo_cierre');

IF @anchoActual IS NULL
    PRINT N'-- dbo.tok_sesion.motivo_cierre no existe: revisar 00-crear-base.sql';
ELSE IF @anchoActual < 21
BEGIN
    ALTER TABLE dbo.tok_sesion ALTER COLUMN motivo_cierre nvarchar(30) NULL;
    PRINT N'-- motivo_cierre: nvarchar(' + CAST(@anchoActual AS nvarchar(10))
        + N') -> nvarchar(30)';
    PRINT N'--   (solicitud_del_usuario son 21 caracteres: con 20 el INSERT del';
    PRINT N'--    panel fallia por longitud en el momento de escribir)';
END
ELSE
    PRINT N'-- motivo_cierre ya es nvarchar(' + CAST(@anchoActual AS nvarchar(10))
        + N') o mas ancha: no se toca';
GO

-- -----------------------------------------------------------------------------
-- 2 · Recrear el CHECK
--
-- `DROP` + `ADD` y no `ALTER COLUMN`: la definicion del CHECK es lo unico que
-- cambia. El nombre de la constraint se mantiene, y por eso el rollback es legible
-- desde cualquier base.
--
-- Se hace con `WITH CHECK` (el default): el motor valida las filas que ya estan, y
-- si alguna tuviera un motivo fuera de la lista nueva este script falla **antes** de
-- tocarla. Es lo que se quiere: un `motivo_cierre` con un valor que la lista nueva no
-- conoce significa que alguien escribio a mano, y hay que saberlo ahora.
-- -----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints
               WHERE name = N'CK_tok_sesion_motivo'
                 AND parent_object_id = OBJECT_ID(N'dbo.tok_sesion'))
BEGIN
    PRINT N'-- AVISO: dbo.tok_sesion no tiene CK_tok_sesion_motivo.';
    PRINT N'--       Este script no la crea: si la base esta incompleta, el problema';
    PRINT N'--       es otro y hay que revisar 00-crear-base.sql primero.';
END
ELSE
BEGIN
    ALTER TABLE dbo.tok_sesion DROP CONSTRAINT CK_tok_sesion_motivo;
    PRINT N'-- Quitada CK_tok_sesion_motivo (4 valores)';

    ALTER TABLE dbo.tok_sesion WITH CHECK
        ADD CONSTRAINT CK_tok_sesion_motivo
        CHECK (motivo_cierre IN (N'logout', N'revocada', N'replay', N'expirada',
                                 N'soporte', N'sospecha', N'reemplazo',
                                 N'solicitud_del_usuario', N'otro'));
    PRINT N'-- Agregada CK_tok_sesion_motivo (9 valores)';
END
GO

-- -----------------------------------------------------------------------------
-- 3 · Comprobar que el ancho alcanza para el valor mas largo
--
-- Esta seccion ya no puede "fallar": es la que verifica que el paso 1 sirvio. Se
-- deja como comprobacion y no como logica porque es la pregunta que alguien se va a
-- hacer cuando un cierre del panel no se pueda guardar ("el motivo no entra"), y
-- contestarla con un SELECT es mas rapido que abrir el DDL.
-- -----------------------------------------------------------------------------
DECLARE @ancho int = (
    SELECT c.max_length / 2
    FROM sys.columns c
    WHERE c.object_id = OBJECT_ID(N'dbo.tok_sesion')
      AND c.name = N'motivo_cierre');

DECLARE @masLargo int = LEN(N'solicitud_del_usuario');

IF @ancho IS NULL
    PRINT N'-- dbo.tok_sesion.motivo_cierre no existe: revisar 00-crear-base.sql';
ELSE IF @ancho < @masLargo
    PRINT N'-- FALLA: motivo_cierre es nvarchar(' + CAST(@ancho AS nvarchar(10))
        + N') y el motivo mas largo mide ' + CAST(@masLargo AS nvarchar(10))
        + N'. Aplicar de nuevo este script.';
ELSE
    PRINT N'-- El ancho alcanza: nvarchar(' + CAST(@ancho AS nvarchar(10))
        + N') para un motivo de ' + CAST(@masLargo AS nvarchar(10)) + N' caracteres';
GO

-- =============================================================================
-- 4 · Verificacion
--
-- Lo que tiene que verse: la constraint con los nueve valores, el ancho que alcanza
-- y **cero** filas con un motivo que no este en la lista (esa comprobacion la hace el
-- propio CHECK al recrearlo, y se vuelve a mirar aca para que quede en la salida).
-- =============================================================================
PRINT N'';
PRINT N'--- VERIFICACION · 02 · tok_sesion.motivo_cierre ---';
PRINT N'';

PRINT N'--- 1 · La columna y la constraint ---';
SELECT
    CAST((SELECT c.max_length / 2 FROM sys.columns c
          WHERE c.object_id = OBJECT_ID(N'dbo.tok_sesion')
            AND c.name = N'motivo_cierre') AS nvarchar(10)) AS ancho,
    cc.name AS constraint_,
    REPLACE(REPLACE(cc.definition, N'[', N''), N']', N'') AS definicion,
    -- `is_not_trusted` en 1 significa que el CHECK existe pero NO valida las filas
    -- que ya estaban (o sea, se creo con NOCHECK). Tiene que dar 0.
    CASE WHEN cc.is_not_trusted = 1 THEN N'NO VALIDA LAS FILAS EXISTENTES' ELSE N'confiable' END AS confianza
FROM sys.check_constraints cc
WHERE cc.name = N'CK_tok_sesion_motivo';
GO

PRINT N'--- 2 · Motivos en uso (historia de la base) ---';
SELECT
    ISNULL(motivo_cierre, N'(sesion abierta)') AS motivo,
    COUNT(*)                                  AS sesiones
FROM dbo.tok_sesion
GROUP BY motivo_cierre
ORDER BY sesiones DESC;
GO

PRINT N'--- 3 · Lo que tiene que dar 0 ---';
SELECT
    -- Un motivo fuera de la lista cerrada no puede existir con el CHECK activo, pero
    -- se mira igual: es la consulta que alguien va a correr cuando "no puedo cerrar
    -- esta sesion".
    (SELECT COUNT(*) FROM dbo.tok_sesion
        WHERE motivo_cierre IS NOT NULL
          AND motivo_cierre NOT IN (N'logout', N'revocada', N'replay', N'expirada',
                                    N'soporte', N'sospecha', N'reemplazo',
                                    N'solicitud_del_usuario', N'otro'))       AS motivos_fuera_de_lista,
    -- Una sesion cerrada sin motivo es un cierre sin explicacion, que es justo lo que
    -- el panel no tiene que poder producir. Las historicas pueden tenerla (CASCADE de
    -- antes de la 08), asi que esto informa, no falla.
    (SELECT COUNT(*) FROM dbo.tok_sesion
        WHERE cerrada_en IS NOT NULL AND motivo_cierre IS NULL)               AS cerradas_sin_motivo;
GO

PRINT N'';
PRINT N'-- 02 aplicado.';
PRINT N'-- Siguiente: 99-verificar-esquema.sql, para comprobar que el camino';
PRINT N'-- incremental deja el mismo esquema que 00-crear-base.sql.';
GO

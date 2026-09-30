-- =============================================================================
-- Tourniquet · 03 · MFA: segundo factor TOTP, códigos de recuperación y desafío
-- MOTOR: SQL Server
--
-- QUE CAMBIA
--   1. `dbo.idn_usuario.mfa_ultimo_periodo bigint NULL` (nueva columna).
--   2. `dbo.idn_usuario_mfa_codigo` (nueva tabla) + 2 índices.
--   3. `dbo.tok_mfa_challenge` (nueva tabla) + 2 índices.
--
--   Ojo: `mfa_secret_cifrada` y `mfa_estado` **ya existen** desde la Fase 01. No se
--   tocan: es el esqueleto que quedó en el DDL esperando a esta fase.
--
-- POR QUE
--   La Fase 09 enciende el segundo factor (`specs/01` §8), y para eso faltaban tres
--   cosas que no cabían en las columnas del esqueleto:
--
--   1. `mfa_ultimo_periodo`: la ventana ±1 de TOTP (`specs/01` §8.3) hace que un
--      código válido en el período N también valida en N+1. Sin guardar el último
--      período aceptado, un código espiado en el límite sirve dos veces. Se guarda
--      el **período** (floor(epoch/30)), no un timestamp, porque la comparación es
--      entre enteros y no entre fechas con zona.
--
--   2. `idn_usuario_mfa_codigo`: los códigos de recuperación no son una columna de
--      `idn_usuario` porque son **N** (10), de un solo uso, y con fecha de uso. En
--      una columna `nvarchar` de ancho fijo no se puede tener "10 filas, una usada y
--      otra no", y una lista separada por comas en texto no se puede consultar ni
--      borrar con un `WHERE`. Es `idn_` y no `tok_` porque la vida del código es la
--      de la persona, no la de un intento.
--
--   3. `tok_mfa_challenge`: el login con MFA es un login en **dos pasos**, y entre
--      los dos pasos tiene que sobrevivir algo que diga de qué usuario, de qué
--      cliente y a qué destino se trata. No se puede poner eso en la respuesta
--      (el cliente lo puede alterar) ni en una cookie sin firma (sería un
--      `tenant` elegido por el pedido, que es justo lo que `AGENTS.md` prohíbe), así
--      que es una fila. Es `tok_` porque su vida es la del intento: vive 5 minutos
--      y se marca usada.
--
--   Por qué el desafío guarda el `idcliente` y el `return_to` YA RESUELTOS, en vez
--   de que el segundo paso los vuelva a pedir: `POST /auth/mfa/verify` no recibe
--   usuario, ni cliente, ni destino. Todo lo que el cliente podría nombrar por su
--   cuenta se toma de una fila que el servidor escribió, y un F5 en la pantalla
--   de verificación no rompe el ingreso.
--
-- AFECTA
--   dbo.idn_usuario: UNA columna nueva, nullable, sin default. No se tocan
--   `mfa_secret_cifrada` ni `mfa_estado`, y ninguna fila existente cambia: todos
--   los usuarios quedan en `mfa_estado='off'` hasta que un admin active el MFA.
--
--   OJO con el orden de los lotes: la columna de `idn_usuario` va **primero**, y las
--   dos tablas después. Al revés funciona igual hoy, pero deja la base en un
--   estado donde `tok_mfa_challenge` existe y el `UPDATE` que anti-reusa el código
--   todavía no tiene dónde escribir.
--
-- ROLLBACK
--   Es un cambio aditivo, así que el rollback es borrar lo agregado:
--
--     DROP TABLE dbo.tok_mfa_challenge;            -- y sus índices, que caen con ella
--     DROP TABLE dbo.idn_usuario_mfa_codigo;       -- ídem
--     ALTER TABLE dbo.idn_usuario DROP COLUMN mfa_ultimo_periodo;
--
--   Con una advertencia: si en la base hubo MFA real, el rollback **deja la
--   instalación sin segundo factor** y sin rastro de que lo hubo. Los usuarios con
--   `mfa_estado='on'` se quedan en `on` con `mfa_secret_cifrada` poblada y el
--   portal pidiéndoles un código que ya no tiene dónde validar. Si se llega a este
--   punto: `UPDATE dbo.idn_usuario SET mfa_estado = N'off',
--   mfa_secret_cifrada = NULL WHERE mfa_estado = N'on';` ANTES de dropear, y
--   avisar a los usuarios de que el segundo factor se desactivó.
--
--   La alternativa —desactivar este script— es la correcta en una instalación con
--   MFA encendida: el rollback de un segundo factor no es una operación de esquema.
-- =============================================================================


SET NOCOUNT ON;
GO

PRINT N'-- ===========================================';
PRINT N'-- 03 · MFA: segundo factor TOTP';
PRINT N'-- AFECTA: idn_usuario.mfa_ultimo_periodo, + idn_usuario_mfa_codigo';
PRINT N'--         y tok_mfa_challenge (nuevas)';
PRINT N'-- ROLLBACK: en la cabecera de este archivo (con advertencia sobre MFA viva)';
PRINT N'-- ===========================================';
GO


-- -----------------------------------------------------------------------------
-- 1 · La columna anti-reuso
--
-- Nullable y sin DEFAULT a propósito: `NULL` significa "todavía no se aceptó ningún
-- período": es el estado real de toda base recién creada, y también el de
-- cualquiera que aún no haya activado MFA. Un `DEFAULT 0` mentía
-- sobre el segundo caso.
--
-- Es idempotente: si ya existe, no hace nada.
-- -----------------------------------------------------------------------------
IF NOT EXISTS (SELECT 1 FROM sys.columns
               WHERE object_id = OBJECT_ID(N'dbo.idn_usuario')
                 AND name = N'mfa_ultimo_periodo')
BEGIN
    ALTER TABLE dbo.idn_usuario
        ADD mfa_ultimo_periodo bigint NULL;

    PRINT N'-- Agregada dbo.idn_usuario.mfa_ultimo_periodo (bigint NULL)';
    PRINT N'--   Ultimo periodo TOTP aceptado. Un periodo <= a este se rechaza:';
    PRINT N'--   la ventana +-1 del reloj es tambien la ventana de reuso.';
END
ELSE
    PRINT N'-- dbo.idn_usuario.mfa_ultimo_periodo ya existe: no se hace nada';
GO


-- -----------------------------------------------------------------------------
-- 2 · idn_usuario_mfa_codigo
--
-- `ON DELETE CASCADE` hacia `idn_usuario`, igual que las otras dos hijas de
-- identidad: un código de recuperación sin usuario no significa nada.
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.idn_usuario_mfa_codigo', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.idn_usuario_mfa_codigo
    (
        id          bigint IDENTITY(1,1) NOT NULL,
        idusuario   uniqueidentifier   NOT NULL,
        codigo_hash nvarchar(64)       NOT NULL,
        creado_en   datetime2(3)       NOT NULL
                    CONSTRAINT DF_idn_mfa_codigo_creado DEFAULT sysutcdatetime(),
        usado_en    datetime2(3)       NULL,
        CONSTRAINT PK_idn_usuario_mfa_codigo PRIMARY KEY (id),
        CONSTRAINT FK_idn_mfa_codigo_usuario
            FOREIGN KEY (idusuario) REFERENCES dbo.idn_usuario (idusuario)
            ON DELETE CASCADE ON UPDATE NO ACTION
    );
    PRINT N'-- Creada dbo.idn_usuario_mfa_codigo';
END
ELSE
    PRINT N'-- dbo.idn_usuario_mfa_codigo ya existe: no se hace nada';
GO

-- El UNIQUE del hash es la búsqueda del código que tipea el usuario. Sin él,
-- "usar el código" tendría que ser un findFirst sobre una tabla sin índice, y dos
-- filas con el mismo hash harían la operación ambigua.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'UQ_idn_usuario_mfa_codigo_hash'
                 AND object_id = OBJECT_ID(N'dbo.idn_usuario_mfa_codigo'))
BEGIN
    CREATE UNIQUE INDEX UQ_idn_usuario_mfa_codigo_hash
        ON dbo.idn_usuario_mfa_codigo (codigo_hash);
    PRINT N'-- Indice UQ_idn_usuario_mfa_codigo_hash';
END
ELSE
    PRINT N'-- Indice UQ_idn_usuario_mfa_codigo_hash ya existe: no se hace nada';
GO

-- Responde "¿cuántos códigos le quedan?" (`/me/mfa`) sin recorrer los ya usados.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_idn_usuario_mfa_codigo_usuario'
                 AND object_id = OBJECT_ID(N'dbo.idn_usuario_mfa_codigo'))
BEGIN
    CREATE INDEX IX_idn_usuario_mfa_codigo_usuario
        ON dbo.idn_usuario_mfa_codigo (idusuario, usado_en);
    PRINT N'-- Indice IX_idn_usuario_mfa_codigo_usuario';
END
ELSE
    PRINT N'-- Indice IX_idn_usuario_mfa_codigo_usuario ya existe: no se hace nada';
GO


-- -----------------------------------------------------------------------------
-- 3 · tok_mfa_challenge
--
-- FKs con `ON DELETE NO ACTION` hacia usuario y cliente, como las demas tablas
-- `tok_`: un login a medias es un evento que se mira, no algo que se borre en
-- cascada cuando se da de baja la cuenta.
-- -----------------------------------------------------------------------------
IF OBJECT_ID(N'dbo.tok_mfa_challenge', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.tok_mfa_challenge
    (
        id         uniqueidentifier NOT NULL,
        idusuario  uniqueidentifier   NOT NULL,
        idcliente  nvarchar(20)       NOT NULL,
        -- Ancho = MAX_LONGITUD de auth/return-to.ts. Si el destino legitimo no
        -- entra, el login con MFA deja de poder volver al authorize.
        return_to  nvarchar(2048)     NOT NULL,
        ip         nvarchar(45)       NOT NULL,
        user_agent nvarchar(500)      NOT NULL,
        creado_en  datetime2(3)       NOT NULL
                   CONSTRAINT DF_tok_mfa_challenge_creado DEFAULT sysutcdatetime(),
        expira_en  datetime2(3)       NOT NULL,
        intentos   smallint           NOT NULL
                   CONSTRAINT DF_tok_mfa_challenge_intentos DEFAULT 0,
        usado_en   datetime2(3)       NULL,
        CONSTRAINT PK_tok_mfa_challenge PRIMARY KEY (id),
        CONSTRAINT FK_tok_mfa_challenge_usuario
            FOREIGN KEY (idusuario) REFERENCES dbo.idn_usuario (idusuario)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT FK_tok_mfa_challenge_cliente
            FOREIGN KEY (idcliente) REFERENCES dbo.cat_cliente (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        -- Solo el piso: el tope de 5 es politica de la app (MAX_INTENTOS_MFA), no
        -- del esquema. Si manana sube a 6, el CHECK no puede tapar el valor.
        CONSTRAINT CK_tok_mfa_challenge_intentos CHECK (intentos >= 0)
    );
    PRINT N'-- Creada dbo.tok_mfa_challenge';
END
ELSE
    PRINT N'-- dbo.tok_mfa_challenge ya existe: no se hace nada';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_tok_mfa_challenge_expira'
                 AND object_id = OBJECT_ID(N'dbo.tok_mfa_challenge'))
BEGIN
    CREATE INDEX IX_tok_mfa_challenge_expira
        ON dbo.tok_mfa_challenge (expira_en);
    PRINT N'-- Indice IX_tok_mfa_challenge_expira (lo purga el job 95)';
END
ELSE
    PRINT N'-- Indice IX_tok_mfa_challenge_expira ya existe: no se hace nada';
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_tok_mfa_challenge_usuario'
                 AND object_id = OBJECT_ID(N'dbo.tok_mfa_challenge'))
BEGIN
    CREATE INDEX IX_tok_mfa_challenge_usuario
        ON dbo.tok_mfa_challenge (idusuario, creado_en DESC);
    PRINT N'-- Indice IX_tok_mfa_challenge_usuario';
END
ELSE
    PRINT N'-- Indice IX_tok_mfa_challenge_usuario ya existe: no se hace nada';
GO


-- =============================================================================
-- 4 · Verificacion
--
-- Lo que tiene que verse: los tres objetos, los indices, las acciones de las FKs
-- (que son el dato que mas se olvida en un incremental) y **cero** usuarios con
-- MFA encendido sin secret.
--
-- Esa ultima comprobacion es la que hace util este script mas adelante: si un dia
-- un `UPDATE` a mano pone `mfa_estado='on'` sin `mfa_secret_cifrada`, el portal
-- queda pidiendo un codigo que no se puede validar, y el unico sintoma es que
-- "el login con MFA no funciona" sin decir por que. Esta consulta es la que
-- responde.
-- =============================================================================
PRINT N'';
PRINT N'--- VERIFICACION · 03 · MFA ---';
PRINT N'';

PRINT N'--- 1 · Objetos (los tres tienen que dar OK) ---';
-- Sin tabla derivada a proposito: un `VALUES (...) AS o(nombre, object_id, columna)`
-- con una columna llamada `object_id` no compila en T-SQL ("El nombre de columna
-- 'object_id' no es valido", Msg 207), y un verificador que no corre es peor que
-- uno que no existe. Tres `UNION ALL` de una fila cada uno, y cada uno con su
-- propio `EXISTS`/`OBJECT_ID`.
SELECT
    N'columna'                                                          AS tipo,
    N'dbo.idn_usuario.mfa_ultimo_periodo'                               AS objeto,
    CASE WHEN EXISTS (SELECT 1 FROM sys.columns
                     WHERE object_id = OBJECT_ID(N'dbo.idn_usuario')
                       AND name = N'mfa_ultimo_periodo')
         THEN N'OK' ELSE N'AUSENTE' END                                AS estado
UNION ALL
SELECT
    N'tabla',
    N'dbo.idn_usuario_mfa_codigo',
    CASE WHEN OBJECT_ID(N'dbo.idn_usuario_mfa_codigo', N'U') IS NULL
         THEN N'AUSENTE' ELSE N'OK' END
UNION ALL
SELECT
    N'tabla',
    N'dbo.tok_mfa_challenge',
    CASE WHEN OBJECT_ID(N'dbo.tok_mfa_challenge', N'U') IS NULL
         THEN N'AUSENTE' ELSE N'OK' END;
GO

PRINT N'--- 2 · Las dos tablas nuevas, con su PK y sus FKs ---';
-- La columna referida sale de `sys.foreign_key_columns`, NO de
-- `sys.foreign_keys.referenced_column_id`: en SQL Server 2022 (probado contra
-- 16.0.1000.6 Express) esa columna de la vista de catalogo no resuelve y la
-- consulta muere con Msg 207 "El nombre de columna 'referenced_column_id' no es
-- valido". `sys.foreign_key_columns` si la tiene, y es la forma portable.
--
-- Y los `CAST(... AS NVARCHAR) COLLATE DATABASE_DEFAULT` en las concatenaciones
-- no son cosmeticos: sin ellos, mezclar el nvarchar de la base de datos con el
-- de catalogo (Latin1_General_CI_AS_KS_WS contra SQL_Latin1_General_CP1_CI_AS) da
-- Msg 451 "No se puede resolver el conflicto de intercalacion". Se mira en el
-- 99-verificar-esquema.sql tambien, que tiene el mismo patron.
SELECT
    t.name                                                             AS tabla,
    fk.name                                                            AS constraint_,
    c.name COLLATE DATABASE_DEFAULT + N' -> ' +
        CAST(OBJECT_NAME(fk.referenced_object_id) AS NVARCHAR(200)) + N'(' +
        COL_NAME(fk.referenced_object_id, fkc.referenced_column_id) + N')' +
        N' ON DELETE ' + CAST(fk.delete_referential_action_desc AS NVARCHAR(200)) +
        N' ON UPDATE ' + CAST(fk.update_referential_action_desc AS NVARCHAR(200))
                                                                    AS detalle
FROM sys.foreign_keys fk
JOIN sys.tables t              ON t.object_id = fk.parent_object_id
JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
JOIN sys.columns c              ON c.object_id = fkc.parent_object_id
                               AND c.column_id = fkc.parent_column_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND t.name IN (N'idn_usuario_mfa_codigo', N'tok_mfa_challenge')
ORDER BY t.name, fk.name;
GO

PRINT N'--- 3 · Indices de las tablas de la Fase 09 ---';
-- El `ic.index_id = i.index_id` NO es opcional: sin el, el `STUFF` recorre las
-- columnas de **todos** los indices de la tabla y los imprime en cada fila, y la
-- salida dice que el PK de una tabla tiene cuatro columnas. Como el
-- `99-verificar-esquema.sql` compara dos bases con la misma consulta, una
-- coincidencia equivocada no rompe la comparación, pero vuelve inútil el
-- informe: la huella vieja tenía el mismo defecto y se corrigió acá.
SELECT
    i.name                                                       AS indice,
    OBJECT_NAME(i.object_id)                                     AS tabla,
    i.is_unique                                                  AS unico,
    STUFF((SELECT N', ' + COL_NAME(ic.object_id, ic.column_id)
                     + CASE WHEN ic.is_descending_key = 1 THEN N' DESC' ELSE N'' END
           FROM sys.index_columns ic
           WHERE ic.object_id = i.object_id
             AND ic.index_id = i.index_id
             AND ic.index_column_id = ic.key_ordinal
             AND ic.is_included_column = 0
           ORDER BY ic.key_ordinal
           FOR XML PATH('')), 1, 2, N'')                        AS columnas
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND t.name IN (N'idn_usuario_mfa_codigo', N'tok_mfa_challenge')
  AND i.name IS NOT NULL
ORDER BY t.name, i.name;
GO

PRINT N'--- 4 · Estado del MFA por usuario (tiene que dar 0 en los tres) ---';
SELECT
    -- MFA encendido sin secret: el login pediria un codigo imposible de validar.
    (SELECT COUNT(*) FROM dbo.idn_usuario
        WHERE mfa_estado = N'on' AND mfa_secret_cifrada IS NULL)      AS on_sin_secret,
    -- Secret poblado con MFA apagado: un leftover de un desactivado mal hecho.
    (SELECT COUNT(*) FROM dbo.idn_usuario
        WHERE mfa_estado = N'off' AND mfa_secret_cifrada IS NOT NULL)  AS off_con_secret,
    -- Periodo anti-reuso escrito sin MFA encendido: no hace falta y confunde.
    (SELECT COUNT(*) FROM dbo.idn_usuario
        WHERE mfa_estado <> N'on' AND mfa_ultimo_periodo IS NOT NULL) AS periodo_sin_mfa;
GO

PRINT N'--- 5 · Lo que hay que mirar despues de aplicar ---';
PRINT N'-- 1. Si un usuario tiene MFA pending: que el portal NO le pida codigo';
PRINT N'--    todavia (specs/01 §8.1). Se prueba entrando con ese usuario.';
PRINT N'-- 2. Agendar los jobs 95-98 (deploy/README.md y el runbook de jobs):';
PRINT N'--    sin el 95, tok_mfa_challenge y los codigos vencidos crecen solos.';
PRINT N'-- 3. El backend necesita el binario con el schema nuevo:';
PRINT N'--    npm run prisma:generate --workspace backend  y reiniciar.';

PRINT N'';
PRINT N'-- 03 aplicado.';
PRINT N'-- Siguiente: 99-verificar-esquema.sql, para comprobar que el camino';
PRINT N'-- incremental deja el mismo esquema que 00-crear-base.sql.';
GO

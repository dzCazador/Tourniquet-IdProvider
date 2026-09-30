-- =============================================================================
-- Tourniquet · 00 · Crear la base de control desde cero
-- MOTOR: SQL Server (unico motor de este repo; no hay variante .mysql.sql)
--
-- QUE ES ESTE SCRIPT
--   Estado COMPLETO y vigente de la base de control. Crea la base si no existe y
--   las 12 tablas `cat_*` / `idn_*` / `tok_*` / `aud_*` con sus indices, tal como los define `specs/02-base-de-datos.md`.
--   Es el que se usa para:
--     - instalar una instalacion nueva de un cliente (Fase 10);
--     - reconstruir una base destruida;
--     - levantar `tourniquet_dev` en una maquina nueva.
--
-- COMO SE RELACIONA CON LOS SCRIPTS INCREMENTALES (NN-*.sql)
--   Son DOS caminos que deben dejar la base EXACTAMENTE IGUAL:
--     (A) este archivo, de una vez;
--     (B) `00-crear-base.sql` -> `01-*.sql` -> `02-*.sql` -> ... en orden.
--   La diferencia entre (A) y (B) es solo el camino recorrido: mismo esquema.
--   Eso se comprueba con `99-verificar-esquema.sql` (ver `deploy/README.md`).
--   REGLA: todo cambio de esquema se entrega en DOS archivos y en el MISMO commit:
--     1. un incremental `NN-<cambio>.sql` (para bases ya instaladas);
--     2. la actualizacion de este archivo, para que no quede desactualizado.
--     Si divergen, es un defecto: se detecta en la verificacion de la fase.
--
-- QUIEN LO EJECUTA
--   El USUARIO. Este script crea bases: no lo ejecuta el agente nunca.
--   El agente solo aplica SQL con `scripts/ejecutar-sql-dev.mjs`, cuya guardia
--   aborta si la base no es exactamente `tourniquet_dev` (ver `AGENTS.md`).
--   Para desarrollo, aplicar el bloque 2 en adelante sobre `tourniquet_dev`:
--   el runner de dev salta TODO el bloque 0 (CREATE DATABASE + USE) porque el
--   marcador @fin-bloque-base esta despues del USE. Ver `deploy/README.md`.
--
-- BASE DE DATOS
--   Produccion: tourniquet
--   Desarrollo: tourniquet_dev   (la crea a mano: el runner NUNCA crea bases)
--   D3 de `specs/00-arquitectura.md`: una instancia por cliente, una base de control
--   propia. Tourniquet NO se conecta a las bases de negocio de las apps.
-- =============================================================================


-- =============================================================================
-- BLOQUE 0 · Crear la base y abrirla  (NO lo aplica el runner de dev)
-- CREATE DATABASE no puede ir dentro de una transaccion, asi que va en su propio
-- lote. Adentro de un IF si se puede, que es lo que hace que el script sea
-- re-corrible: si la base ya existe, no falla.
-- =============================================================================
IF DB_ID(N'tourniquet') IS NULL
BEGIN
    PRINT N'-- Creando la base [tourniquet]...';
    CREATE DATABASE [tourniquet];
END
ELSE
BEGIN
    PRINT N'-- La base [tourniquet] ya existe: se continua con el esquema.';
END
GO

USE [tourniquet];
GO

-- Aca termina el bloque 0. El marcador va DESPUES del USE a proposito: el runner
-- de desarrollo salta todo lo que este arriba, incluido el USE, y asi el esquema
-- se aplica sobre la base de la conexion (tourniquet_dev) y nunca sobre
-- [tourniquet]. Si el USE quedara debajo de esta linea, el runner saltaria el
-- CREATE pero escribiria el esquema en la base equivocada.
-- @fin-bloque-base

SET NOCOUNT ON;
GO


-- =============================================================================
-- BLOQUE 1 · Convenciones (de `specs/02-base-de-datos.md` §2 y §2.1)
--
-- Prefijo        FUNCION, uno de cuatro: cat_ (catalogo/tenancy), idn_ (identidad),
--                tok_ (sesion y tokens), aud_ (auditoria). Ver §2.1.
-- PK             `id` o `id<entidad>`; naturales de negocio cuando son cortas (`codigo`)
-- FKs            reales y explicitas. ON UPDATE: NO ACTION en TODAS, porque la
--                PK referenciada (cat_cliente.codigo, cat_aplicacion.codigo,
--                idn_usuario.idusuario) es el tenant/aud de tokens ya emitidos
--                y no se renombra. ON DELETE: NO ACTION salvo
--                `idn_usuario_cliente`/`idn_usuario_cliente_aplicacion` ->
--                idn_usuario y `cat_cliente_aplicacion` -> cliente/aplicacion
--                (CASCADE: dependencia fuerte). OJO: SQL Server rechaza con
--                1785 dos rutas a la misma tabla con acciones distintas, y
--                lo evalua por separado para DELETE y para UPDATE
--                (OJO: en T-SQL la palabra es NO ACTION, NO "RESTRICT", que es
--                del SQL estandar y MySQL/Postgres: da error de sintaxis),
--                CASCADE solo en idn_usuario_cliente y idn_usuario_cliente_aplicacion
--                (hacia idn_usuario). En el resto, NO ACTION: ademas SQL Server
--                rechaza con 1785 una tabla con dos rutas a la misma tabla con
--                acciones distintas
-- UUID           uniqueidentifier; lo genera la app (crypto.randomUUID()),
--                el SQL no depende de newid()
-- Timestamps     datetime2(3) en UTC, default sysutcdatetime().
--                `creado_en` siempre; `actualizado_en` solo en entidades mutables
--                (NUNCA en aud_login, tok_sesion ni tok_refresh_token)
-- TEXT           nvarchar(max) para JSON y clave publica; nvarchar(n) acotado para el resto
-- Cifrado        varbinary(512) = iv(12) | tag(16) | ciphertext   (AES-256-GCM)
-- Nombres        sin enie ni acentos en nombres de columna; el espanol se conserva
--                en los DATOS, no en los identificadores
--
-- NOTA sobre `idcliente` / `idaplicacion`: pese al nombre, no son GUID: son los
-- valores de `cat_cliente.codigo` y `cat_aplicacion.codigo`, que son las PK naturales
-- y corta, y ademas son el `aud` y el `tenant` que viajan en el token
-- (`specs/01-tokenos-y-seguridad.md` §2). De ahi que no haya columna de codigo
-- duplicada.
-- =============================================================================


-- =============================================================================
-- BLOQUE 2 · Esquema completo
-- Orden de creacion: siguen las dependencias de FK.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 2.1 · Registro de plataforma
-- -----------------------------------------------------------------------------

-- cat_cliente: el inquilino. Chile y AR del mismo cliente son UN tenant con
-- varias bases y varias apps, no dos tenants.
IF OBJECT_ID(N'dbo.cat_cliente', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.cat_cliente
    (
        codigo        nvarchar(20)  NOT NULL,
        nombre        nvarchar(100) NOT NULL,
        estado        nvarchar(10)  NOT NULL
                      CONSTRAINT DF_cat_cliente_estado DEFAULT N'activo',
        -- Politica de contrasenas, MFA, tema visual del portal. NULL = defaults del
        -- spec. Es JSON libre y versionable; no se lee en el camino de login.
        politica_json nvarchar(max)  NULL,
        CONSTRAINT PK_cat_cliente PRIMARY KEY (codigo),
        CONSTRAINT CK_cat_cliente_estado CHECK (estado IN (N'activo', N'inactivo'))
    );
    PRINT N'-- Creada dbo.cat_cliente';
END
GO

-- cat_aplicacion: catalogo GLOBAL de aplicaciones de la casa (rhpro, rhpro-chile,
-- futuras). `codigo` es la PK y es el `aud` que emite el token, asi que no puede
-- ser un id numerico: cambiarlo rompe URLs y claims ya emitidos.
IF OBJECT_ID(N'dbo.cat_aplicacion', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.cat_aplicacion
    (
        codigo             nvarchar(40)  NOT NULL,
        nombre             nvarchar(100) NOT NULL,
        -- Solo `public` (con PKCE) esta implementado. `confidential` NO esta
        -- diseñado: `specs/01` §1. La columna queda reservada, no habilitada.
        tipo_cliente       nvarchar(20)  NOT NULL
                           CONSTRAINT DF_cat_aplicacion_tipo DEFAULT N'public',
        -- Lista JSON de URIs EXACTAS. Sin comodines, sin prefijos. Es la defensa
        -- contra redirect abierto y robo de code (`specs/01` §9).
        redirect_uris_json nvarchar(max)  NOT NULL,
        -- Lista JSON de origenes CORS exactos. Nunca `*` (`specs/01` §4).
        origenes_json      nvarchar(max)  NOT NULL,
        estado             nvarchar(10)  NOT NULL
                           CONSTRAINT DF_cat_aplicacion_estado DEFAULT N'activo',
        -- URL donde el lanzador del portal ABRE la app (Fase 07). Es la pagina que
        -- inicia el flujo OIDC de la app: su `state` y su challenge, no una pagina
        -- de presentacion.
        --
        -- Va REGISTRADA y no deducida del `redirect_uri` a proposito. Deducirla
        -- (origen + `/login`) parece gratis y no lo es: el dia que una app tenga
        -- otra convencion de paths, el lanzador abre una URL que no existe y el
        -- unico sintoma es un 404 del web server del cliente, que no senala al
        -- IdP. No es un control de seguridad: no se valida ni se compara contra
        -- nada, es un link que el usuario aprieta. Ver `specs/01` §1.2.
        --
        -- DECLARADA AL FINAL, y no junto a las otras de configuracion de la app,
        -- por una razon mecanica: `ALTER TABLE ADD` siempre agrega la columna al
        -- final de la tabla, asi que este es el unico lugar donde el camino (A) de
        -- `specs/02` §5.1 y el camino (B) (los incrementales) pueden dejar las
        -- columnas en el MISMO orden. `99-verificar-esquema.sql` imprime la huella
        -- ordenada por `column_id`, y un orden distinto aparece como diferencia
        -- entre los dos caminos aunque el esquema sea el mismo.
        url_inicio         nvarchar(1000) NOT NULL,
        CONSTRAINT PK_cat_aplicacion PRIMARY KEY (codigo),
        CONSTRAINT CK_cat_aplicacion_estado CHECK (estado IN (N'activo', N'inactivo')),
        CONSTRAINT CK_cat_aplicacion_tipo CHECK (tipo_cliente IN (N'public'))
    );
    PRINT N'-- Creada dbo.cat_aplicacion';
END
GO

-- cat_cliente_aplicacion: que apps existen PARA este cliente.
IF OBJECT_ID(N'dbo.cat_cliente_aplicacion', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.cat_cliente_aplicacion
    (
        idcliente    nvarchar(20) NOT NULL,
        idaplicacion nvarchar(40) NOT NULL,
        CONSTRAINT PK_cat_cliente_aplicacion PRIMARY KEY (idcliente, idaplicacion),
        CONSTRAINT FK_cat_cliente_aplicacion_cliente
            FOREIGN KEY (idcliente) REFERENCES dbo.cat_cliente (codigo)
            ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT FK_cat_cliente_aplicacion_aplicacion
            FOREIGN KEY (idaplicacion) REFERENCES dbo.cat_aplicacion (codigo)
            ON DELETE CASCADE ON UPDATE NO ACTION
    );
    PRINT N'-- Creada dbo.cat_cliente_aplicacion';
END
GO

-- cat_base_datos: INVENTARIO (D3 de `specs/00-arquitectura.md`). Tourniquet NO abre
-- conexiones a bases ajenas: registra datos de conexion para despliegue asistido y
-- para el futuro TenantRegistry de RHPro.
IF OBJECT_ID(N'dbo.cat_base_datos', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.cat_base_datos
    (
        codigo              nvarchar(40)  NOT NULL,
        idcliente           nvarchar(20)  NOT NULL,
        idaplicacion        nvarchar(40)  NOT NULL,
        host                nvarchar(200) NOT NULL,
        [base]              nvarchar(100) NOT NULL,
        -- `esquema` va entre corchetes: SCHEMA es palabra reservada en T-SQL.
        -- Null = esquema por defecto (dbo).
        [esquema]           nvarchar(20)  NULL,
        -- Login de la base ajena. No es secreto y no se expone por API.
        usuario             nvarchar(100) NOT NULL,
        -- iv(12) | tag(16) | ciphertext  (AES-256-GCM, `specs/01` §6).
        -- Lo cifra el servicio; nunca se acepta cifrado desde la API.
        credencial_cifrada  varbinary(512) NULL,
        -- `sqlserver` es el unico motor real del repo. La columna documenta el
        -- inventario; NO habilita una variante MySQL (ver `AGENTS.md` regla 2).
        [engine]            nvarchar(20)  NOT NULL
                            CONSTRAINT DF_cat_base_datos_engine DEFAULT N'sqlserver',
        connection_limit    int           NULL,
        estado              nvarchar(10)  NOT NULL
                            CONSTRAINT DF_cat_base_datos_estado DEFAULT N'activo',
        notas               nvarchar(500) NULL,
        CONSTRAINT PK_cat_base_datos PRIMARY KEY (codigo),
        CONSTRAINT FK_cat_base_datos_cliente
            FOREIGN KEY (idcliente) REFERENCES dbo.cat_cliente (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT FK_cat_base_datos_aplicacion
            FOREIGN KEY (idaplicacion) REFERENCES dbo.cat_aplicacion (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT CK_cat_base_datos_estado CHECK (estado IN (N'activo', N'inactivo')),
        CONSTRAINT CK_cat_base_datos_engine CHECK ([engine] = N'sqlserver')
    );
    PRINT N'-- Creada dbo.cat_base_datos';
END
GO

-- -----------------------------------------------------------------------------
-- 2.2 · Identidad
-- -----------------------------------------------------------------------------

-- idn_usuario: identidad GLOBAL. `usuario` es unico en toda la instalacion, no por
-- tenant: un mismo login en dos clientes es UNA fila aca y dos membresias en
-- idn_usuario_cliente (D6 de `specs/00-arquitectura.md`).
IF OBJECT_ID(N'dbo.idn_usuario', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.idn_usuario
    (
        idusuario           uniqueidentifier NOT NULL,
        -- Se almacena en minuscula, siempre. El login normaliza antes de buscar.
        usuario             nvarchar(50)  NOT NULL,
        nombre              nvarchar(100) NOT NULL,
        apellido            nvarchar(100) NOT NULL,
        email               nvarchar(200) NULL,
        -- argon2id, formato PHC: m=65536, t=3, p=4 (`specs/01` §4). Nunca
        -- sha1/md5/base64 "hash" (AGENTS.md, invariantes de seguridad).
        clave_hash          nvarchar(255) NOT NULL,
        -- iv(12) | tag(16) | ciphertext del secreto TOTP. Null hasta que se
        -- enrola (Fase 09). Nunca sale por API.
        mfa_secret_cifrada  varbinary(512) NULL,
        mfa_estado          nvarchar(10)  NOT NULL
                            CONSTRAINT DF_idn_usuario_mfa_estado DEFAULT N'off',
        estado              nvarchar(10)  NOT NULL
                            CONSTRAINT DF_idn_usuario_estado DEFAULT N'activo',
        intentos_fallidos   int           NOT NULL
                            CONSTRAINT DF_idn_usuario_intentos DEFAULT 0,
        -- 5 intentos fallidos = 15 min de bloqueo (`specs/01` §4).
                        -- Contador POR USUARIO, no por IP.
        bloqueado_hasta     datetime2(3)  NULL,
        creado_en           datetime2(3)  NOT NULL
                            CONSTRAINT DF_idn_usuario_creado DEFAULT sysutcdatetime(),
        -- Solo en entidades mutables.
        actualizado_en      datetime2(3)  NULL,
        CONSTRAINT PK_idn_usuario PRIMARY KEY (idusuario),
        CONSTRAINT CK_idn_usuario_mfa_estado
            CHECK (mfa_estado IN (N'off', N'pending', N'on')),
        CONSTRAINT CK_idn_usuario_estado
            CHECK (estado IN (N'activo', N'bloqueado', N'inactivo')),
        CONSTRAINT CK_idn_usuario_intentos CHECK (intentos_fallidos >= 0)
    );
    PRINT N'-- Creada dbo.idn_usuario';
END
GO

-- idn_usuario_cliente: membresia al tenant. `rol` es user | admin_identidad.
-- `admin_identidad` habilita accesos y cierra sesiones de ESE cliente (Fase 08).
-- NO es un permiso de negocio: el token no lleva roles (D2 de `specs/00`).
IF OBJECT_ID(N'dbo.idn_usuario_cliente', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.idn_usuario_cliente
    (
        idusuario uniqueidentifier NOT NULL,
        idcliente nvarchar(20)     NOT NULL,
        rol       nvarchar(20)     NOT NULL
                  CONSTRAINT DF_idn_usuario_cliente_rol DEFAULT N'user',
        creado_en datetime2(3)     NOT NULL
                  CONSTRAINT DF_idn_usuario_cliente_creado DEFAULT sysutcdatetime(),
        CONSTRAINT PK_idn_usuario_cliente PRIMARY KEY (idusuario, idcliente),
        CONSTRAINT FK_idn_usuario_cliente_usuario
            FOREIGN KEY (idusuario) REFERENCES dbo.idn_usuario (idusuario)
            ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT FK_idn_usuario_cliente_cliente
            FOREIGN KEY (idcliente) REFERENCES dbo.cat_cliente (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT CK_idn_usuario_cliente_rol
            CHECK (rol IN (N'user', N'admin_identidad'))
    );
    PRINT N'-- Creada dbo.idn_usuario_cliente';
END
GO

-- idn_usuario_cliente_aplicacion: habilitacion de INGRESO por app.
-- Controla solo entrar o no, nunca que se ve adentro (D2 de `specs/00`).
IF OBJECT_ID(N'dbo.idn_usuario_cliente_aplicacion', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.idn_usuario_cliente_aplicacion
    (
        idusuario    uniqueidentifier NOT NULL,
        idcliente    nvarchar(20)     NOT NULL,
        idaplicacion nvarchar(40)     NOT NULL,
        creado_en    datetime2(3)     NOT NULL
                     CONSTRAINT DF_idn_uca_creado DEFAULT sysutcdatetime(),
        CONSTRAINT PK_idn_usuario_cliente_aplicacion
            PRIMARY KEY (idusuario, idcliente, idaplicacion),
        CONSTRAINT FK_idn_uca_usuario
            FOREIGN KEY (idusuario) REFERENCES dbo.idn_usuario (idusuario)
            ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT FK_idn_uca_cliente
            FOREIGN KEY (idcliente) REFERENCES dbo.cat_cliente (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT FK_idn_uca_aplicacion
            FOREIGN KEY (idaplicacion) REFERENCES dbo.cat_aplicacion (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION
    );
    PRINT N'-- Creada dbo.idn_usuario_cliente_aplicacion';
END
GO

-- -----------------------------------------------------------------------------
-- 2.3 · Sesiones y tokens
-- -----------------------------------------------------------------------------

-- tok_sesion: sesion central por APLICACION. El mismo usuario entrando en dos apps
-- tiene dos `sid`. Por eso "salir de todo" revoca todas las sesiones del usuario
-- en el cliente, no una fila.
-- `idaplicacion` NULL = sesion del PORTAL (no de una app): el portal no es una app.
IF OBJECT_ID(N'dbo.tok_sesion', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.tok_sesion
    (
        sid             uniqueidentifier NOT NULL,
        idusuario       uniqueidentifier NOT NULL,
        idcliente       nvarchar(20)     NOT NULL,
        -- NULL = sesion del portal. FK ON DELETE NO ACTION: no se puede borrar una
        -- app que tiene sesiones vivas; se desactiva con estado.
        idaplicacion    nvarchar(40)     NULL,
        -- "pwd" | "pwd,mfa". Es lo que se refleja en el claim `amr`.
        amr             nvarchar(50)     NOT NULL
                         CONSTRAINT DF_tok_sesion_amr DEFAULT N'pwd',
        ip              nvarchar(45)     NOT NULL,
        user_agent      nvarchar(500)    NOT NULL,
        creado_en       datetime2(3)     NOT NULL
                         CONSTRAINT DF_tok_sesion_creado DEFAULT sysutcdatetime(),
        -- Vida ABSOLUTA: 30 dias desde creado_en. El refresh deslizante (7 dias de
        -- inactividad) NUNCA la extiende (`specs/01` §3).
        expira_en       datetime2(3)     NOT NULL,
        -- Sin `actualizado_en`: es append-only con revocacion.
        cerrada_en      datetime2(3)     NULL,
        -- nvarchar(30) y no 20: el motivo mas largo de la lista de abajo
        -- (`solicitud_del_usuario`) mide 21 caracteres, y con 20 el INSERT de un
        -- cierre del panel fallia con un error de longitud en tiempo de escritura.
        -- El incremental `02-sesion-motivo-cierre-admin.sql` amplia la columna y
        -- agrega los cinco motivos de una persona; el ancho y la lista se cambian
        -- juntos y en el mismo archivo.
        motivo_cierre   nvarchar(30)     NULL,
        CONSTRAINT PK_tok_sesion PRIMARY KEY (sid),
        CONSTRAINT FK_tok_sesion_usuario
            FOREIGN KEY (idusuario) REFERENCES dbo.idn_usuario (idusuario)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT FK_tok_sesion_cliente
            FOREIGN KEY (idcliente) REFERENCES dbo.cat_cliente (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT FK_tok_sesion_aplicacion
            FOREIGN KEY (idaplicacion) REFERENCES dbo.cat_aplicacion (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT CK_tok_sesion_motivo
            -- Los cuatro primeros los escribe el sistema. Los cinco del panel los
            -- elige una PERSONA al forzar el cierre de la sesion de un usuario
            -- (Fase 08 §5) y son obligatorios: un cierre sin explicacion es
            -- indistinguible de un abuso. `motivo_cierre` es nvarchar(20) y
            -- `solicitud_del_usuario` entra justo: si alguna vez se agrega un valor
            -- mas largo, hay que hacer un ALTER del ancho Y del CHECK juntos.
            CHECK (motivo_cierre IN (N'logout', N'revocada', N'replay', N'expirada',
                                     N'soporte', N'sospecha', N'reemplazo',
                                     N'solicitud_del_usuario', N'otro'))
    );
    PRINT N'-- Creada dbo.tok_sesion';
END
GO

-- tok_autorization_code: PKCE. Se PERSISTE porque el authorize y el token pueden
-- caer en instancias distintas (si mañana hay mas de una).
-- `code_hash` es sha256 hex (64 car.). nvarchar(128) por margen; el ancho no se
-- cambia despues porque depende el indice unico.
IF OBJECT_ID(N'dbo.tok_autorization_code', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.tok_autorization_code
    (
        id             bigint IDENTITY(1,1) NOT NULL,
        sid            uniqueidentifier   NOT NULL,
        idaplicacion   nvarchar(40)       NOT NULL,
        -- sha256 del code. El code en claro NUNCA se persiste: si alguien lee la
        -- base, no puede canjear codes.
        code_hash      nvarchar(128)      NOT NULL,
        -- base64url(sha256(code_verifier)). Sin esto no hay code (`specs/01` §1).
        code_challenge nvarchar(128)      NOT NULL,
        method         nvarchar(10)       NOT NULL
                       CONSTRAINT DF_tok_authcode_method DEFAULT N'S256',
        -- Se revalida EXACTO contra el del authorize en /oidc/token: validar solo
        -- en el authorize deja el canje abierto a otro redirect_uri.
        redirect_uri   nvarchar(1000)     NOT NULL,
        state_hash     nvarchar(128)      NULL,
        creado_en      datetime2(3)       NOT NULL
                       CONSTRAINT DF_tok_authcode_creado DEFAULT sysutcdatetime(),
        -- 60 segundos, un solo uso (`specs/01` §3).
        expira_en      datetime2(3)       NOT NULL,
        usado_en       datetime2(3)       NULL,
        CONSTRAINT PK_tok_autorization_code PRIMARY KEY (id),
        CONSTRAINT UQ_tok_autorization_code_hash UNIQUE (code_hash),
        -- OJO (Msg 1785, ya tropezado DOS veces). TODAS las FK de este archivo van
            -- con ON UPDATE NO ACTION, y estas dos con ON DELETE NO ACTION
            -- tambien. No desconfies de SQL Server: la PK que se referencia
            -- (cat_cliente.codigo, cat_aplicacion.codigo, idn_usuario.idusuario)
            -- es el `tenant` y el `aud` de los tokens ya emitidos, y esa fila no
            -- se renombra jamas. Con ON UPDATE CASCADE, un cambio de codigo
            -- reescribiria en cascada tokens que terceros ya tienen en mano.
            --
            -- Ademas estas tablas tienen DOS rutas a cat_aplicacion: la directa por
            -- `idaplicacion` y la que pasa por `tok_sesion`. SQL Server exige que
            -- TODAS las rutas hacia una misma tabla tengan la MISMA accion, y lo
            -- evalua por separado para DELETE y para UPDATE. Si difieren en
            -- cualquiera de los dos, el CREATE TABLE entero falla con 1785/1750
            -- y la tabla NO existe.
            --
            -- Ojo con el diagnostico: el error nombra la constraint que se estaba
            -- creando (la directa a cat_aplicacion), que puede ser la que esta
            -- bien; la culpable suele ser la de al lado. Y como el fallo es del
            -- CREATE TABLE completo, las tablas siguientes que lo referencian
            -- fallan con "no existe": cascada de errores, no causas distintas.
            --
            -- NO ACTION en `sid` es lo correcto por dominio ademas: las sesiones
            -- no se borran, se cierran (`cerrada_en`). El borrado fisico de
            -- `tok_sesion` es un bug, y una cascada lo volveria un borrado
            -- silencioso de los tokens de esa sesion.
        CONSTRAINT FK_tok_authcode_sesion
            FOREIGN KEY (sid) REFERENCES dbo.tok_sesion (sid)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT FK_tok_authcode_aplicacion
            FOREIGN KEY (idaplicacion) REFERENCES dbo.cat_aplicacion (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT CK_tok_authcode_method CHECK (method = N'S256')
    );
    PRINT N'-- Creada dbo.tok_autorization_code';
END
GO

-- tok_refresh_token: ROTACION ESTRICTA. De un solo uso; el reuso de uno ya rotado
-- revoca toda la familia del `sid` y auditada `replay` (`specs/01` §3).
IF OBJECT_ID(N'dbo.tok_refresh_token', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.tok_refresh_token
    (
        id              bigint IDENTITY(1,1) NOT NULL,
        sid             uniqueidentifier   NOT NULL,
        idaplicacion    nvarchar(40)       NOT NULL,
        -- sha256 hex (64). El token opaco en claro NUNCA se persiste.
        token_hash      nvarchar(64)       NOT NULL,
        creado_en       datetime2(3)       NOT NULL
                        CONSTRAINT DF_tok_refresh_creado DEFAULT sysutcdatetime(),
        expira_en       datetime2(3)       NOT NULL,
        -- Distingue "vencido" de "ya rotado": un reuso de un rotado es `replay`,
        -- un reuso de un vencido es `expirado`. Se auditan distinto.
        usado_en        datetime2(3)       NULL,
        -- Cadena de rotacion: permite revocar la familia siguiendo el eslabon.
        reemplazado_por bigint            NULL,
        revocado_en     datetime2(3)       NULL,
        motivo          nvarchar(20)       NULL,
        CONSTRAINT PK_tok_refresh_token PRIMARY KEY (id),
        CONSTRAINT UQ_tok_refresh_token_hash UNIQUE (token_hash),
        -- OJO (Msg 1785, ya tropezado DOS veces). TODAS las FK de este archivo van
            -- con ON UPDATE NO ACTION, y estas dos con ON DELETE NO ACTION
            -- tambien. No desconfies de SQL Server: la PK que se referencia
            -- (cat_cliente.codigo, cat_aplicacion.codigo, idn_usuario.idusuario)
            -- es el `tenant` y el `aud` de los tokens ya emitidos, y esa fila no
            -- se renombra jamas. Con ON UPDATE CASCADE, un cambio de codigo
            -- reescribiria en cascada tokens que terceros ya tienen en mano.
            --
            -- Ademas estas tablas tienen DOS rutas a cat_aplicacion: la directa por
            -- `idaplicacion` y la que pasa por `tok_sesion`. SQL Server exige que
            -- TODAS las rutas hacia una misma tabla tengan la MISMA accion, y lo
            -- evalua por separado para DELETE y para UPDATE. Si difieren en
            -- cualquiera de los dos, el CREATE TABLE entero falla con 1785/1750
            -- y la tabla NO existe.
            --
            -- Ojo con el diagnostico: el error nombra la constraint que se estaba
            -- creando (la directa a cat_aplicacion), que puede ser la que esta
            -- bien; la culpable suele ser la de al lado. Y como el fallo es del
            -- CREATE TABLE completo, las tablas siguientes que lo referencian
            -- fallan con "no existe": cascada de errores, no causas distintas.
            --
            -- NO ACTION en `sid` es lo correcto por dominio ademas: las sesiones
            -- no se borran, se cierran (`cerrada_en`). El borrado fisico de
            -- `tok_sesion` es un bug, y una cascada lo volveria un borrado
            -- silencioso de los tokens de esa sesion.
        CONSTRAINT FK_tok_refresh_sesion
            FOREIGN KEY (sid) REFERENCES dbo.tok_sesion (sid)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT FK_tok_refresh_aplicacion
            FOREIGN KEY (idaplicacion) REFERENCES dbo.cat_aplicacion (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        -- FK a si misma para la cadena de rotacion. NO CASCADE: cortar la cadena
        -- vieja no debe borrar los sucesores.
        CONSTRAINT FK_tok_refresh_reemplazado
            FOREIGN KEY (reemplazado_por) REFERENCES dbo.tok_refresh_token (id)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT CK_tok_refresh_motivo
            CHECK (motivo IN (N'logout', N'revocada', N'replay', N'expirada',
                              N'rotado', N'reemplazado'))
    );
    PRINT N'-- Creada dbo.tok_refresh_token';
END
GO

-- -----------------------------------------------------------------------------
-- 2.4 · Infraestructura de seguridad
-- -----------------------------------------------------------------------------

-- tok_clave_firma: par RSA de firma del JWKS. La PRIVADA va cifrada con AES-256-GCM
-- bajo TQ_MASTER_KEY, que vive en el entorno y NUNCA en esta base ni en un backup
-- suelto del .bak (`specs/01` §5).
IF OBJECT_ID(N'dbo.tok_clave_firma', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.tok_clave_firma
    (
        -- Hash corto de la clave publica. Debe ir explicito en el header del token.
        kid                    nvarchar(32)  NOT NULL,
        alg                    nvarchar(10)  NOT NULL
                                CONSTRAINT DF_tok_clave_firma_alg DEFAULT N'RS256',
        clave_publica          nvarchar(max) NOT NULL,
        -- iv(12) | tag(16) | ciphertext
        clave_privada_cifrada  varbinary(max) NOT NULL,
        activa                 bit           NOT NULL
                                CONSTRAINT DF_tok_clave_firma_activa DEFAULT 1,
        creado_en              datetime2(3)  NOT NULL
                                CONSTRAINT DF_tok_clave_firma_creado DEFAULT sysutcdatetime(),
        -- El JWKS sirve la activa + las retiradas dentro de 24 h. Los tokens viejos
        -- expiran solos en 15 min; la ventana de solapamiento es por relojes
        -- desincronizados (`specs/01` §5).
        retirada_en            datetime2(3)  NULL,
        CONSTRAINT PK_tok_clave_firma PRIMARY KEY (kid),
        CONSTRAINT CK_tok_clave_firma_alg CHECK (alg = N'RS256')
    );
    PRINT N'-- Creada dbo.tok_clave_firma';
END
GO

-- aud_login: APPEND-ONLY. Sin UPDATE ni DELETE desde la app: el borrado por
-- antiguedad lo hace un job SQL externo (`specs/01` §7), nunca codigo de negocio.
IF OBJECT_ID(N'dbo.aud_login', N'U') IS NULL
BEGIN
    CREATE TABLE dbo.aud_login
    (
        id          bigint IDENTITY(1,1) NOT NULL,
        ts          datetime2(3)     NOT NULL
                    CONSTRAINT DF_aud_audit_ts DEFAULT sysutcdatetime(),
        -- NULL cuando el login fue de un usuario inexistente: es informacion
        -- distinta a "ese usuario fallo".
        idusuario   uniqueidentifier NULL,
        idaplicacion nvarchar(40)    NULL,
        ip          nvarchar(45)     NOT NULL,
        user_agent  nvarchar(500)    NOT NULL,
        resultado   nvarchar(10)     NOT NULL,
        -- CODIGO corto (clave_incorrecta, usuario_bloqueado, ...), nunca un volcado
        -- del input: un detalle con el usuario tipeado es un vector de enumeracion
        -- de cuentas, ni un volcado del input.
        detalle     nvarchar(500)    NULL,
        CONSTRAINT PK_aud_login PRIMARY KEY (id),
        CONSTRAINT FK_aud_audit_usuario
            FOREIGN KEY (idusuario) REFERENCES dbo.idn_usuario (idusuario)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT FK_aud_audit_aplicacion
            FOREIGN KEY (idaplicacion) REFERENCES dbo.cat_aplicacion (codigo)
            ON DELETE NO ACTION ON UPDATE NO ACTION,
        CONSTRAINT CK_aud_audit_resultado
            CHECK (resultado IN (N'ok', N'claves', N'bloq', N'replay',
                                 N'expirado', N'error'))
    );
    PRINT N'-- Creada dbo.aud_login';
END
GO


-- =============================================================================
-- BLOQUE 3 · Indices
-- De `specs/02-base-de-datos.md` §4.
-- =============================================================================

-- idn_usuario: login unico global, y email unico solo cuando existe.
-- El indice UNICO de (usuario) no alcanza para buscar: el login consulta por
-- usuario, que es la misma columna, pero la unicidad es la garantia.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'UQ_idn_usuario_usuario'
                 AND object_id = OBJECT_ID(N'dbo.idn_usuario'))
BEGIN
    CREATE UNIQUE INDEX UQ_idn_usuario_usuario ON dbo.idn_usuario (usuario);
    PRINT N'-- Indice UQ_idn_usuario_usuario';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'UQ_idn_usuario_email'
                 AND object_id = OBJECT_ID(N'dbo.idn_usuario'))
BEGIN
    CREATE UNIQUE INDEX UQ_idn_usuario_email
        ON dbo.idn_usuario (email)
        WHERE email IS NOT NULL;
    PRINT N'-- Indice UQ_idn_usuario_email (filtrado)';
END
GO

-- Sesiones activas del portal: solo las abiertas. El filtro `cerrada_en IS NULL`
-- mantiene el indice chico para siempre, en vez de crecer con el historico.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_tok_sesion_usuario_aplicacion_activa'
                 AND object_id = OBJECT_ID(N'dbo.tok_sesion'))
BEGIN
    CREATE INDEX IX_tok_sesion_usuario_aplicacion_activa
        ON dbo.tok_sesion (idusuario, idaplicacion, creado_en DESC)
        WHERE cerrada_en IS NULL;
    PRINT N'-- Indice IX_tok_sesion_usuario_aplicacion_activa (filtrado)';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_tok_sesion_cliente_activa'
                 AND object_id = OBJECT_ID(N'dbo.tok_sesion'))
BEGIN
    CREATE INDEX IX_tok_sesion_cliente_activa
        ON dbo.tok_sesion (idcliente, creado_en DESC)
        WHERE cerrada_en IS NULL;
    PRINT N'-- Indice IX_tok_sesion_cliente_activa (filtrado)';
END
GO

-- Rotacion: revocar la familia del sid es la consulta de la alerta de replay.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_tok_refresh_token_sid_aplicacion'
                 AND object_id = OBJECT_ID(N'dbo.tok_refresh_token'))
BEGIN
    CREATE INDEX IX_tok_refresh_token_sid_aplicacion
        ON dbo.tok_refresh_token (sid, idaplicacion);
    PRINT N'-- Indice IX_tok_refresh_token_sid_aplicacion';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_tok_refresh_token_expira'
                 AND object_id = OBJECT_ID(N'dbo.tok_refresh_token'))
BEGIN
    CREATE INDEX IX_tok_refresh_token_expira
        ON dbo.tok_refresh_token (expira_en)
        WHERE revocado_en IS NULL;
    PRINT N'-- Indice IX_tok_refresh_token_expira (filtrado)';
END
GO

-- Limpieza de codes vencidos (job de 5 minutos).
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_tok_autorization_code_expira'
                 AND object_id = OBJECT_ID(N'dbo.tok_autorization_code'))
BEGIN
    CREATE INDEX IX_tok_autorization_code_expira
        ON dbo.tok_autorization_code (expira_en);
    PRINT N'-- Indice IX_tok_autorization_code_expira';
END
GO

-- El job de retencion borra por rango de ts. Con indice por ts solo, cada corrida
-- recorre la tabla entera: por eso existe el indice por (idusuario, ts).
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_aud_login_ts'
                 AND object_id = OBJECT_ID(N'dbo.aud_login'))
BEGIN
    CREATE INDEX IX_aud_login_ts ON dbo.aud_login (ts);
    PRINT N'-- Indice IX_aud_login_ts';
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_aud_login_usuario_ts'
                 AND object_id = OBJECT_ID(N'dbo.aud_login'))
BEGIN
    CREATE INDEX IX_aud_login_usuario_ts
        ON dbo.aud_login (idusuario, ts);
    PRINT N'-- Indice IX_aud_login_usuario_ts';
END
GO

-- Una base ACTIVA por combinacion cliente+app. Las inactivas quedan como
-- historico: por eso el indice es filtrado, no unico a secas.
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'UQ_cat_base_datos_cliente_aplicacion_activa'
                 AND object_id = OBJECT_ID(N'dbo.cat_base_datos'))
BEGIN
    CREATE UNIQUE INDEX UQ_cat_base_datos_cliente_aplicacion_activa
        ON dbo.cat_base_datos (idcliente, idaplicacion)
        WHERE estado = N'activo';
    PRINT N'-- Indice UQ_cat_base_datos_cliente_aplicacion_activa (filtrado)';
END
GO

-- Consulta del panel: roles del tenant (admin_identidad de un cliente).
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE name = N'IX_idn_usuario_cliente_cliente_rol'
                 AND object_id = OBJECT_ID(N'dbo.idn_usuario_cliente'))
BEGIN
    CREATE INDEX IX_idn_usuario_cliente_cliente_rol
        ON dbo.idn_usuario_cliente (idcliente, rol);
    PRINT N'-- Indice IX_idn_usuario_cliente_cliente_rol';
END
GO


-- =============================================================================
-- BLOQUE 4 · Verificacion
-- Imprime el estado real del esquema recien aplicado. Debe dar 12 tablas OK,
-- 0 ausentes, 0 columnas faltantes.
-- =============================================================================
SET NOCOUNT ON;
GO

PRINT N'';
PRINT N'=== VERIFICACION · 00-crear-base.sql ===';
PRINT N'';

-- 4.1 Las 12 tablas esperadas. Se vuelca en una #temporal porque el
-- veredicto final (lote 4.5) la necesita y las #temporales si sobreviven al GO,
-- a diferencia de las variables.
PRINT N'--- 1 · Tablas esperadas (deben ser 12) ---';
IF OBJECT_ID(N'tempdb..#tablas_esperadas') IS NOT NULL DROP TABLE #tablas_esperadas;
SELECT
    e.nombre                                            AS tabla,
    CASE WHEN t.object_id IS NULL THEN N'AUSENTE' ELSE N'OK' END AS estado
INTO #tablas_esperadas
FROM (VALUES
    (N'cat_cliente'), (N'cat_aplicacion'), (N'cat_cliente_aplicacion'),
    (N'cat_base_datos'), (N'idn_usuario'), (N'idn_usuario_cliente'),
    (N'idn_usuario_cliente_aplicacion'), (N'tok_sesion'),
    (N'tok_autorization_code'), (N'tok_refresh_token'),
    (N'tok_clave_firma'), (N'aud_login')
) AS e(nombre)
LEFT JOIN sys.tables t ON t.name = e.nombre AND t.schema_id = SCHEMA_ID(N'dbo')
ORDER BY e.nombre;
SELECT * FROM #tablas_esperadas;
GO

-- 4.2 Conteo de objetos
PRINT N'';
PRINT N'--- 2 · Conteo de objetos ---';
SELECT
    (SELECT COUNT(*) FROM #tablas_esperadas
        WHERE estado = N'OK')                                            AS tablas,
    (SELECT COUNT(*) FROM sys.indexes i
        JOIN sys.tables t ON t.object_id = i.object_id
        WHERE t.schema_id = SCHEMA_ID(N'dbo')
          AND i.name IS NOT NULL)                                          AS indices,
    (SELECT COUNT(*) FROM sys.foreign_keys
        WHERE parent_object_id IN (SELECT object_id FROM sys.tables
                                    WHERE schema_id = SCHEMA_ID(N'dbo'))) AS foreign_keys,
    (SELECT COUNT(*) FROM sys.check_constraints
        WHERE parent_object_id IN (SELECT object_id FROM sys.tables
                                    WHERE schema_id = SCHEMA_ID(N'dbo'))) AS check_constraints;
GO

-- 4.3 Material cifrado: si alguien guardo una master key o una clave privada
-- en texto en vez de binario, esta consulta lo delata.
PRINT N'';
PRINT N'--- 3 · Columnas de material cifrado (deben ser binarias) ---';
IF OBJECT_ID(N'tempdb..#cifrado') IS NOT NULL DROP TABLE #cifrado;
SELECT
    c.name                          AS columna,
    ty.name                         AS tipo,
    c.max_length                    AS bytes_max,
    CASE
        WHEN ty.name IN (N'varbinary', N'binary') THEN N'OK (binario)'
        WHEN ty.name IN (N'nvarchar', N'varchar', N'nchar')
             THEN N'FALLA: es texto, no binario'
        ELSE N'revisar'
    END                             AS veredicto
INTO #cifrado
FROM sys.columns c
JOIN sys.tables t  ON t.object_id = c.object_id
JOIN sys.types  ty ON ty.user_type_id = c.user_type_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND c.name IN (N'credencial_cifrada', N'mfa_secret_cifrada',
                 N'clave_privada_cifrada')
ORDER BY c.name;
SELECT * FROM #cifrado;
GO

-- 4.4 Indices filtrados: son los que sostienen el rendimiento del portal, y
-- esta consulta detecta si un CREATE INDEX ... WHERE se perdio.
PRINT N'';
PRINT N'--- 4 · Indices filtrados (esperados: 5) ---';
IF OBJECT_ID(N'tempdb..#filtrados') IS NOT NULL DROP TABLE #filtrados;
SELECT
    i.name                                                     AS indice,
    OBJECT_NAME(i.object_id)                                   AS tabla,
    STUFF((SELECT ', ' + COL_NAME(ic.object_id, ic.column_id)
                     + CASE WHEN ic.is_descending_key = 1 THEN ' DESC' ELSE '' END
           FROM sys.index_columns ic
           WHERE ic.object_id = i.object_id
             AND ic.index_column_id = ic.key_ordinal
             AND ic.is_included_column = 0
           ORDER BY ic.key_ordinal
           FOR XML PATH('')), 1, 2, '')                       AS columnas,
    i.filter_definition                                       AS condicion
INTO #filtrados
FROM sys.indexes i
JOIN sys.tables t ON t.object_id = i.object_id
WHERE t.schema_id = SCHEMA_ID(N'dbo')
  AND i.has_filter = 1
  AND i.is_primary_key = 0
  AND i.name IS NOT NULL
ORDER BY i.name;
SELECT * FROM #filtrados;
GO

-- 4.5 Veredicto. Sale por PRINT y por THROW, no solo por result set: asi se ve
-- siempre, y si el esquema quedo incompleto el script FALLA de verdad en vez de
-- solo avisar. Un 00 que "termina bien" con 10 de 12 tablas es peor que uno que
-- se cae: el error aparece aca y no tres fases despues.
PRINT N'';
PRINT N'--- 5 · Veredicto ---';
DECLARE @tablas INT = (SELECT COUNT(*) FROM #tablas_esperadas
                       WHERE estado = N'OK');
DECLARE @ausentes INT = (SELECT COUNT(*) FROM #tablas_esperadas
                         WHERE estado = N'AUSENTE');
DECLARE @faltantes NVARCHAR(400) = (
    SELECT STRING_AGG(tabla, N', ') WITHIN GROUP (ORDER BY tabla)
    FROM #tablas_esperadas WHERE estado = N'AUSENTE');
DECLARE @filtrados INT = (SELECT COUNT(*) FROM #filtrados);
DECLARE @texto_cifrado INT = (SELECT COUNT(*) FROM #cifrado
                              WHERE veredicto LIKE N'FALLA%');

PRINT N'Tablas propias   : ' + CAST(@tablas AS NVARCHAR(10)) + N' / 12'
      + CASE WHEN @tablas = 12 AND @ausentes = 0 THEN N'   OK'
             ELSE N'   FALTA: ' + ISNULL(@faltantes, N'?') END;
PRINT N'Indices filtrados : ' + CAST(@filtrados AS NVARCHAR(10)) + N' / 5'
      + CASE WHEN @filtrados = 5 THEN N'   OK' ELSE N'   REVISAR' END;
PRINT N'Cifrado en texto  : ' + CAST(@texto_cifrado AS NVARCHAR(10))
      + CASE WHEN @texto_cifrado = 0 THEN N'   OK (todo binario)'
             ELSE N'   FALLA: material cifrado guardado como texto' END;

IF @tablas <> 12 OR @ausentes > 0 OR @texto_cifrado > 0
BEGIN
    DECLARE @msg NVARCHAR(600) =
        N'Esquema incompleto: ' + CAST(@tablas AS NVARCHAR(10)) + N'/12 tablas'
        + CASE WHEN @faltantes IS NOT NULL
               THEN N'. Faltan: ' + @faltantes ELSE N'' END
        + CASE WHEN @texto_cifrado > 0
               THEN N'. Material cifrado guardado como texto.' ELSE N'' END
        + N'. El primer error del log es la causa real; los siguientes suelen'
        + N' ser cascada.';
    THROW 50000, @msg, 1;
END

PRINT N'';
PRINT N'ESQUEMA APLICADO CORRECTAMENTE. Siguiente paso: 90-semilla-catalogo.sql';
PRINT N'(en una instalacion de cliente, NO: la semilla la genera';
PRINT N' scripts/generar-instalacion.mjs con los datos reales. Ver deploy/README.md).';
GO

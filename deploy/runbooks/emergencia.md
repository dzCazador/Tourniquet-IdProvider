# Runbook — Entrada de emergencia

> **Este runbook es el más corto y el más importante.** Todo lo demás de
> `deploy/runbooks/` existe para que este funcione.

Si Tourniquet está caído —servidor, base, master key, red, certificado— la pregunta
no es "cómo lo arreglo". La pregunta es **"cómo entra la gente a trabajar
mañana"**. La respuesta tiene que estar escrita **antes** del incidente, con un
nombre y una ubicación, y no después.

Es la Fase 00 convertida en procedimiento (`fase-00-login-local-rhpro.md`, D5 de
`specs/00-arquitectura.md`).

---

## 1 · La cuenta

**Una cuenta de emergencia en RHPro, local, que no pasa por Tourniquet.**

- Login propio, **no** el de una persona: si usa el login de alguien, ese alguien
  queda con auditoría de accesos que no hizo.
- Clave larga, **en sobre cerrado**, en la caja fuerte del cliente. No en un correo,
  no en un chat, no en el `.env` del servidor.
- **MFA desactivado** en esa cuenta, o el código en el mismo sobre: el objetivo es
  entrar sin Tourniquet y sin un segundo factor de terceros.
- Rol `admin_identidad` de ese cliente, para que pueda dar de alta a la gente si
  hace falta.
- **No es** una cuenta de uso diario. Es la que se abre cuando Tourniquet está
  caído y se cierra cuando se arregla.

## 2 · Dónde están las credenciales

Tres cosas, y las tres en el acta de instalación:

| | |
|---|---|
| **Quién tiene el sobre** | Nombre y apellido de una persona, no "sistemas" |
| **Dónde está el sobre** | Caja fuerte del cliente, con su número de llave |
| **Quién más sabe que existe** | El responsable de seguridad del cliente, que **no** tiene la clave |

Una caja fuerte de la que tres personas tienen la llave sigue siendo una caja
fuerte con una ventana: el sobre tiene que estar en un lugar, con una persona, y
el **conocimiento** de que existe se separa de la **posesión** de la clave.

## 3 · Cuándo se usa

**Solo** cuando una de estas cosas es cierta:

1. Tourniquet no responde y **no se va a arreglar en la jornada**.
2. La clave de Tourniquet se **filtró** o se perdió, hasta que la nueva esté en su
   sitio.
3. Hay una **falla de seguridad** abierta contra el IdP.

Y en ningún otro caso. En particular:

- **No** para "entrar más rápido".
- **No** para probar. Probar el camino de emergencia con **Tourniquet apagado**
  (`instalacion.md` §12, punto 7) no es usarlo: es probar que funciona.
- **No** para saltarse un MFA. Si una persona pide la clave de emergencia porque
  perdió su TOTP, lo que corresponde es `npm run resetear:clave`.

## 4 · Cómo se usa

```
Tourniquet CAÍDO
      │
      ├─ 1. RHPro con AUTH_MODO=local          (rollback.md, fila 2)
      ├─ 2. Login local de la cuenta de emergencia
      ├─ 3. La gente entra con su usuario y clave de siempre
      └─ 4. Anotar en el acta: quién, cuándo, por qué, qué hizo
```

Cada uso queda anotado con **hora, motivo y qué se hizo adentro**. Eso no es
burocracia: es lo que permite reconstruir después qué pasó con la información de
la empresa, y es lo que un cliente va a preguntar la primera vez que esto se use.

## 5 · Qué hacer al mismo tiempo

El uso de la cuenta de emergencia **no** cancela la reparación. En paralelo:

| Si el síntoma es… | Lo primero |
|---|---|
| El backend no responde | El **reloj** del servidor (`instalacion.md` §1.1). Es el primer sospechoso siempre |
| La base no conecta | ¿Hay base? ¿Hay espacio en disco? ¿Sigue el servicio SQL? |
| Todo responde pero el login falla | ¿El `issuer`? `curl .well-known/openid-configuration` y comparar **carácter a carácter** con `TQ_ISSUER` |
| El discovery responde y el login no | ¿La cookie? Origen del portal distinto del de la API, `SameSite` (ver `instalacion.md` §10) |
| Se filtró algo | Rotar la clave de firma **primero**, revocar sesiones, después investigar (`rollback.md`, fila 7) |

## 6 · Cómo se cierra

- La cuenta de emergencia: **no se cambia la clave por usar**. Cambiarla cada vez
  obliga a redistribuir el sobre, y un sobre que se distribuye seguido es un sobre
  que se pierde.
- Se registra el incidente: qué pasó, cuánto duró, quién lo detectó, cómo se
  resolvió.
- Si la causa fue de infraestructura, se agrega el paso al checklist de
  `instalacion.md` §1.
- **Se revisa el sobre.** Un sobre que se usó hace seis meses y quedó en el mismo
  lugar con la misma clave es un sobre que alguien encontró.

## 7 · La prueba

**Una vez al año**, y el día en que se instaló:

1. Parar el servicio `TourniquetApi`.
2. Poner `AUTH_MODO=local` en RHPro.
3. Entrar con la cuenta de emergencia, desde una máquina normal, con la red del
   cliente.
4. Confirmar que alguien con un usuario común también entra.
5. Prender Tourniquet, volver a `dual`, y **probar el punto 7 de la prueba de
   humo** de nuevo.

Se anota en el acta con fecha. Una prueba que no tiene fecha no existe.

---

## Lo que **no** es la entrada de emergencia

| No sirve | Por qué |
|---|---|
| Una clave de administrador de SQL | No entra a la aplicación: entra a la base. Y deja acceso a los datos de la empresa |
| Un token vencido guardado en un archivo | Los access tokens duran 15 minutos y no hay forma de renovar uno sin el IdP |
| Un refresh token "que funciona por un tiempo" | Un refresh se puede revocar desde el panel en cualquier momento. Guardar uno es guardar una puerta que se puede cerrar |
| Desactivar el MFA de toda la empresa | Convierte un incidente del IdP en un incidente de credenciales |
| `npm run resetear:clave` para todo el mundo | Cada cambio de clave es un argon2id, y **cierra las sesiones** de esa persona. Con 400 personas, 400 cierres de sesión, y ninguno entra |

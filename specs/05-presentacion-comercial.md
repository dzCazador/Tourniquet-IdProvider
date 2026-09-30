# 05 — Presentación comercial de Tourniquet

> **Documento no normativo.** No agrega requisitos técnicos ni contradice a los specs
> `00`–`04`. Es material de venta y de comunicación: está escrito para gerentes,
> decisores de negocio y usuarios finales, no para desarrolladores. Si algo de acá
> choca con un spec, manda el spec.

---

## 1. El pitch de un minuto

Hoy cada persona de la empresa tiene una contraseña distinta para cada sistema.
Cada sistema nuevo significa otra clave que recordar, otra alta que hacer a mano y
otra baja que a nadie se le ocurre ejecutar el día que alguien se va.

**Tourniquet es la puerta de entrada única a todos los sistemas de la empresa.**
La persona se identifica **una sola vez**, con **un solo usuario y una sola
contraseña**, y desde ahí entra a todas las aplicaciones que tenga habilitadas, sin
volver a tipear nada.

No es una aplicación de negocio más: es la **puerta de identidad** de toda la suite.
El nombre es la idea: un *tourniquet* es el instrumento que **comprime un flujo para
controlarlo**. Tourniquet comprime en un solo punto el desorden de accesos de la
empresa.

---

## 2. El problema que resuelve

Toda empresa que crece en sistemas arrastra los mismos dolores:

| Dolor | Qué cuesta en la práctica |
|---|---|
| **Muchas contraseñas** | Olvidos, post-its, claves compartidas, llamados al soporte de TI |
| **Altas y bajas dispersas** | Cuando entra o se va una persona hay que tocar cada sistema por separado; siempre se olvida uno |
| **Cada sistema nuevo reinventa el login** | Desarrollar y mantener el login se repite una y otra vez |
| **Sin trazabilidad** | No hay una respuesta rápida a "¿quién entró, cuándo y desde dónde?" |
| **Auditorías difíciles** | Demostrar control de accesos exige juntar información de N sistemas distintos |
| **Riesgo silencioso** | Un exempleado cuyos accesos quedaron abiertos en algún sistema |

---

## 3. Qué es Tourniquet (en una imagen)

```
        El usuario                         La empresa
            │                                  │
            ▼                                  ▼
   ┌─────────────────┐                ┌───────────────────┐
   │   TOURNIQUET    │                │  Administración    │
   │  (una entrada,  │                │  de accesos y      │
   │   un usuario)   │                │  auditoría         │
   └────────┬────────┘                └───────────────────┘
            │  elige la app
   ┌────────┼────────┬─────────────┐
   ▼        ▼        ▼             ▼
 RHPro AR  RHPro    Sistema de   …cualquier
           Chile    Legajos      app futura
```

El empleado ve **una sola pantalla**. Detrás, Tourniquet se encarga de confirmar
quién es y de entregar a cada sistema la prueba de que puede dejarlo pasar. Los
sistemas de la empresa no necesitan conocerse entre sí ni saber cómo está armado
Tourniquet.

**Todo lo que la empresa tenga conectado, bajo una sola puerta.**

---

## 4. Qué hace a Tourniquet atractivo

En tres planos, según a quién le preguntemos.

### 4.1 Para el usuario: menos fricción, más simple

- **Una sola clave.** Se acuerda de una, no de cinco.
- **No vuelve a loguearse entre apps.** Entra al portal y salta de un sistema a otro
  sin tipear de nuevo.
- **Ve sólo lo suyo.** Si pertenece a una o varias empresas, el portal le muestra las
  aplicaciones habilitadas de cada una. Nunca ve lo que no le corresponde.
- **Control de sus sesiones.** Puede ver dónde está conectado y cerrar sesión cuando
  quiera — "cerrar esta aplicación" o "salir de todo".
- **Una sola pantalla, clara.** El portal está pensado para leerse de una, incluso a
  las 3 de la mañana en un puesto de trabajo compartido.

### 4.2 Para el gerente de negocio: control, riesgo y costo

- **Identidad centralizada.** Una sola política de accesos para toda la suite, en vez
  de una distinta por sistema.
- **Onboarding y offboarding en un solo lugar.** Alta de una persona y sus accesos
  desde el portal; baja central cuando se va (y el camino para que esa baja alcance a
  todas las apps está diseñado, no improvisado).
- **Trazabilidad real.** Queda registro de cada ingreso: quién, cuándo, desde dónde y
  con qué resultado. Consultable y exportable.
- **Sesiones que se pueden cortar.** Un administrador puede forzar el cierre de la
  sesión de un usuario, con motivo auditado.
- **Menos tickets de soporte.** Las llamadas por "me olvidé la contraseña" y "no me
  anda el acceso a X" se reducen a un único lugar.
- **Cumplimiento más fácil.** Demostrar control de accesos deja de ser una cacería por
  los sistemas de la empresa.

### 4.3 Para TI y para el negocio técnico: estándar, seguro y escalable

- **Tecnología estándar de la industria (OIDC).** Tourniquet habla el mismo idioma que
  usan Google, Microsoft y los grandes sistemas del mercado. Eso significa que **no hay
  que rediseñar nada** cuando mañana se quiera sumar una app nueva o conectar el login
  corporativo del cliente (su Windows/Office 365, por ejemplo).
- **Cada app se conecta por configuración, no por código.** Sumar un sistema nuevo es
  un registro, no un proyecto de desarrollo.
- **Aislamiento entre clientes garantizado.** Si Tourniquet atiende a varias empresas,
  cada una ve estrictamente lo suyo; el sistema está construido para que un cliente no
  pueda ver ni entrar a datos de otro.
- **La aplicación puede estar en cualquier lado.** El sistema de la empresa puede vivir
  en otro servidor, otra red, otro datacenter: Tourniquet igual le da identidad. No
  hace falta tener todo junto.
- **La marca es del cliente.** La apariencia del portal es configurable por empresa,
  así cada cliente siente el sistema como propio.

---

## 5. La seguridad, explicada sin tecnicismos

La seguridad es un argumento de venta, no un detalle para especialistas. En términos
comerciales, Tourniquet protege así:

| Riesgo concreto | Cómo lo controla Tourniquet |
|---|---|
| **Contraseña robada o débil** | Políticas de contraseña fuertes, bloqueo automático tras varios intentos fallidos y MFA (segundo factor) en camino |
| **Robo de la sesión** | Las sesiones son cortas y se renuevan solas de forma segura; una sesión robada deja de servir en minutos |
| **Saber quién entró** | Registro completo e inviolable de cada acceso |
| **Accesos que quedan abiertos** | Cierre de sesión central, de todas las apps a la vez |
| **Que un cliente vea a otro** | Aislamiento estricto entre empresas, verificado en cada operación |
| **Filtración de datos sensibles** | Las claves y credenciales se guardan cifradas, nunca en texto plano |
| **Que la puerta única sea un punto de fallo** | Existe un **modo de emergencia local**: si Tourniquet no responde, los sistemas críticos tienen un camino alternativo para que el personal no quede afuera |

Ese último punto es una de las decisiones más importantes del diseño: **Tourniquet no
es un cuello de botella que pueda dejar a toda la empresa sin trabajar.** Es la puerta
principal, con salida de emergencia.

---

## 6. Antes y después

| Situación | Sin Tourniquet | Con Tourniquet |
|---|---|---|
| Entrar a trabajar | Una clave distinta por sistema | Un usuario y una clave |
| Cambiar de aplicación | Volver a loguearse | Salto directo, sin re-escribir clave |
| Sumar una app nueva | Desarrollar un login nuevo | Registrarla y conectarla |
| Alta de un empleado | Tocar cada sistema por separado | Un punto de administración |
| Baja de un empleado | Revisar sistema por sistema | Cierre central de accesos |
| "¿Quién entró a X?" | Preguntar en cada sistema | Un solo registro consultable |
| Auditoría de accesos | Semanas de recopilación | Reporte del portal |
| Si el login central falla | — | Modo de emergencia local |

---

## 7. Casos de uso

- **Suite RHPro (Argentina y Chile):** un colaborador de una empresa usa RHPro AR y
  RHPro Chile con el mismo usuario; Tourniquet le muestra sólo las que le habilitaron.
- **Grupo con varias razones sociales:** una persona trabaja para dos empresas del
  grupo; entra a cada una con su mismo usuario y ve únicamente las apps de cada una.
- **Cliente con su sistema en otro proveedor:** la aplicación vive en un servidor
  externo; Tourniquet igual le da identidad y el usuario no nota la diferencia.
- **Onboarding corporativo:** cuando entra gente nueva, el área de Sistemas habilita
  sus accesos desde un único panel.
- **Compliance y auditoría interna:** ante un pedido de "quién tuvo acceso a qué",
  el registro central responde en minutos.

---

## 8. Qué es Tourniquet y qué no es

Para evitar expectativas equivocadas desde el minuto cero:

| Tourniquet **es** | Tourniquet **no es** |
|---|---|
| La puerta única de acceso a todos los sistemas | Un sistema de gestión de RRHH o de negocio |
| El tablero donde se administran permisos de acceso | El lugar donde se deciden permisos *dentro* de cada app |
| El registro de auditoría de los ingresos | Un reemplazo de los sistemas que la empresa ya usa |
| La plataforma que conecta apps nuevas sin rehacer el login | Un producto que haya que desarrollar para cada cliente |

> **La regla de oro del diseño:** Tourniquet dice **quién sos**. Cada aplicación
> decide **qué podés hacer** adentro. Así nunca hay dos verdades sobre los permisos ni
> conflictos entre sistemas.

---

## 9. Por qué es un buen negocio para quien lo vende

- **Reutilizable.** Un producto de identidad sirve a toda la cartera de clientes, en
  todos los países y todas las apps. Se construye una vez.
- **Escalable comercialmente.** Sumar un cliente nuevo es registrarlo, no volver a
  desarrollar. El crecimiento no multiplica el costo de ingeniería.
- **Abre la puerta a servicios de terceros.** Como usa el estándar del mercado,
  cualquier app externa puede integrarse sin trabajo especial, y eso amplía la
  oferta de la suite.
- **Sinergia con la suite.** RHPro y las apps futuras se vuelven más fáciles de vender
  juntas: "un acceso, todo el ecosistema".
- **Defensa frente a la competencia.** El login único, la auditoría y el control de
  accesos son argumentos que la competencia sin identidad centralizada no puede dar.

---

## 10. Preguntas frecuentes

**¿Tengo que cambiar la forma en que trabajo hoy?**
No. El usuario sigue entrando a las mismas aplicaciones; lo único que cambia es que
ahora lo hace con un solo usuario desde una pantalla única.

**¿Y si ya usamos Google o Microsoft para entrar?**
Es compatible. Tourniquet usa el mismo estándar abierto (OIDC), así que en el futuro
se puede conectar el login corporativo sin rehacer nada. Es una mejora prevista.

**¿Qué pasa si Tourniquet se cae?**
Las aplicaciones críticas tienen un **modo local de emergencia** para que el personal
no quede sin trabajar. Tourniquet es la puerta principal, no un punto único de fracaso.

**¿Un cliente puede ver datos de otro?**
No. El aislamiento entre empresas está garantizado en el propio diseño y se controla
en cada operación.

**¿Sirve si nuestro sistema está en otro servidor?**
Sí. Tourniquet sólo se ocupa de la identidad; la aplicación puede estar donde esté.

**¿Podemos ponerle nuestra marca?**
Sí. La apariencia del portal es configurable por cliente.

**¿Y el segundo factor (MFA)?**
Está diseñado y previsto. Se activa según lo que pida cada contrato.

**¿Se puede ver todo lo que pasó?**
Sí: cada ingreso queda registrado de forma inalterable, con quién, cuándo, desde dónde
y el resultado.

---

## 11. Para el usuario final (texto de comunicación interno)

> **Ahora entrás con un solo usuario.**
>
> A partir de ahora vas a tener **un único usuario y una única contraseña** para todos
> los sistemas de la empresa. Te identificás una vez y, desde ahí, elegís a qué
> aplicación querés entrar —sin volver a escribir la clave.
>
> - Vas a ver únicamente las aplicaciones que tenés habilitadas.
> - Podés revisar y cerrar tus sesiones cuando quieras.
> - Si te olvidás la contraseña, ya no tenés que llamar por cada sistema: se resuelve
>   en un solo lugar.
>
> Es más simple, más seguro y todo queda en una sola pantalla.

---

## 12. Cierre

Tourniquet convierte el desorden de accesos de una empresa en **un solo punto de
entrada claro, seguro y auditable**. Para el usuario es simplicidad: una clave, todas
las apps. Para el negocio es control: menos riesgo, menos costo, mejor cumplimiento.
Para quien vende la suite es una plataforma reutilizable que crece sin multiplicar el
esfuerzo.

**Una entrada. Todas las aplicaciones. Bajo control.**

---

## 13. Glosario para no técnicos

| Término | Qué significa en la práctica |
|---|---|
| **SSO (single sign-on / login único)** | Iniciar sesión una vez y quedar habilitado en todos los sistemas |
| **IdP (proveedor de identidad)** | El sistema que confirma quién es cada persona. Tourniquet lo es |
| **Portal / lanzador** | La pantalla donde el usuario elige a qué aplicación entrar |
| **Cliente / tenant** | Cada empresa que usa la plataforma |
| **Aplicación / app** | Cada sistema de la empresa (por ejemplo, RHPro) |
| **Sesión** | El período durante el cual una persona está conectada |
| **OIDC** | El estándar abierto de login que usan Google, Microsoft y la industria |
| **MFA** | Segundo factor de seguridad, además de la contraseña |
| **Auditoría** | El registro de quién hizo qué y cuándo |
| **Aislamiento** | Que una empresa nunca puede ver ni tocar los datos de otra |
| **Modo de emergencia local** | Camino alternativo de acceso si la puerta central no responde |

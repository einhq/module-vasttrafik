# module-vasttrafik

Västtrafik's departures, vehicle positions and disruptions, as dashboard cards, a map layer and commands.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/vasttrafik`, and a deployment chooses whether to run it. It needs an application of
your own at [developer.vasttrafik.se](https://developer.vasttrafik.se) that subscribes to
Planera Resa v4, Geografi v3 and Störning v1; its authentication key goes in the setting `CFG_VASTTRAFIK_KEY`.

The documentation is at [einhq.eu/docs/vasttrafik](https://einhq.eu/docs/vasttrafik/).

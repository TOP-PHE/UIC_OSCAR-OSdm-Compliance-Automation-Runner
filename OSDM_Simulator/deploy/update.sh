#!/bin/sh
# Copyright [2026] [International Union of Railways (UIC)]
#
#    Licensed under the Apache License, Version 2.0 (the "License");
#    you may not use this file except in compliance with the License.
#    You may obtain a copy of the License at
#        http://www.apache.org/licenses/LICENSE-2.0
#
# update.sh — update the installed simulator (#617): pull the checkout and
# restart the container. A restart clears every booking and token.
#
# Installed once, by hand, OUTSIDE the checkout (see the operations page,
# "Update the simulator"), and named as the only command of the deploy key in
# authorized_keys. A copy outside the checkout means a merge to main cannot
# change what that key may run. Re-copy it by hand only after reading it.
set -eu
CHECKOUT=/opt/osdm-simulator
git -C "$CHECKOUT" pull --ff-only --quiet
cd "$CHECKOUT/OSDM_Simulator/deploy"
docker compose restart

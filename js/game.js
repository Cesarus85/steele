import * as THREE from 'three';

class RealSteelARGame {
    constructor() {
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.xrSession = null;
        this.xrReferenceSpace = null;
        this.hitTestSource = null;

        // Robot and placement
        this.robot = null;
        this.robotPlaced = false;
        this.reticle = null;

        // Controllers
        this.controllers = [];
        this.controllerGrips = [];

        // Game state
        this.robotPosition = new THREE.Vector3();
        this.robotRotation = 0;
        this.robotVelocity = new THREE.Vector3();
        this.isJumping = false;
        this.jumpVelocity = 0;

        // Input state
        this.inputState = {
            leftStick: { x: 0, y: 0 },
            rightStick: { x: 0, y: 0 },
            aButton: false,
            aPrevious: false
        };

        // Hand targets for IK - initialize to forward boxing position
        this.leftHandTarget = new THREE.Vector3(-0.3, 1.1, 0.3);
        this.rightHandTarget = new THREE.Vector3(0.3, 1.1, 0.3);
        this.currentForwardAxisLocal = new THREE.Vector3(0, 0, 1);

        this.init();
    }

    async init() {
        this.updateStatus('Checking WebXR support...');

        if (!navigator.xr) {
            this.updateStatus('WebXR not supported');
            return;
        }

        const supported = await navigator.xr.isSessionSupported('immersive-ar');
        if (!supported) {
            this.updateStatus('AR not supported');
            return;
        }

        this.setupThreeJS();
        this.setupReticle();
        this.updateStatus('Ready for AR');

        const enterARButton = document.getElementById('enterAR');
        enterARButton.disabled = false;
        enterARButton.addEventListener('click', () => this.startAR());
    }

    setupThreeJS() {
        // Scene
        this.scene = new THREE.Scene();

        // Camera
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.renderer.xr.enabled = true;
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

        document.getElementById('container').appendChild(this.renderer.domElement);

        // Lighting
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight.position.set(10, 10, 5);
        directionalLight.castShadow = true;
        directionalLight.shadow.mapSize.width = 2048;
        directionalLight.shadow.mapSize.height = 2048;
        this.scene.add(directionalLight);

        // Start render loop
        this.renderer.setAnimationLoop((time, frame) => this.render(time, frame));
    }

    setupReticle() {
        const geometry = new THREE.RingGeometry(0.15, 0.2, 32);
        const material = new THREE.MeshBasicMaterial({
            color: 0x00ff00,
            transparent: true,
            opacity: 0.7
        });

        this.reticle = new THREE.Mesh(geometry, material);
        this.reticle.matrixAutoUpdate = false;
        this.reticle.visible = false;
        this.scene.add(this.reticle);
    }

    async startAR() {
        try {
            this.updateStatus('Starting AR session...');

            // Request AR session with minimal required features
            this.xrSession = await navigator.xr.requestSession('immersive-ar', {
                requiredFeatures: ['hit-test'],
                optionalFeatures: ['local-floor', 'dom-overlay'],
                domOverlay: { root: document.body }
            });

            this.updateStatus('AR session created, setting up...');

            await this.renderer.xr.setSession(this.xrSession);

            // Setup reference space with fallback
            try {
                this.xrReferenceSpace = await this.xrSession.requestReferenceSpace('local-floor');
                this.updateStatus('Using local-floor reference space');
            } catch (e) {
                console.warn('local-floor not supported, falling back to local:', e);
                try {
                    this.xrReferenceSpace = await this.xrSession.requestReferenceSpace('local');
                    this.updateStatus('Using local reference space');
                } catch (e2) {
                    console.error('Failed to get any reference space:', e2);
                    throw new Error('No supported reference space found');
                }
            }

            // Setup hit test
            try {
                const viewerSpace = await this.xrSession.requestReferenceSpace('viewer');
                this.hitTestSource = await this.xrSession.requestHitTestSource({ space: viewerSpace });
                this.updateStatus('Hit test source created');
            } catch (e) {
                console.warn('Hit test setup failed:', e);
                this.updateStatus('AR active (no hit test) - Use controller select');
            }

            // Setup controllers
            this.setupControllers();

            this.updateStatus('AR session active - Look for ground plane or use select');

            this.xrSession.addEventListener('end', () => {
                this.hitTestSource = null;
                this.updateStatus('AR session ended');
            });

        } catch (error) {
            console.error('Failed to start AR:', error);
            this.updateStatus('Failed to start AR: ' + error.message);

            // Show specific error guidance
            if (error.message.includes('local-floor')) {
                this.updateStatus('Device doesn\'t support floor tracking. Try on Quest/other AR device.');
            }
        }
    }

    setupControllers() {
        // Controller 1
        const controller1 = this.renderer.xr.getController(0);
        controller1.addEventListener('selectstart', () => this.onSelect());
        controller1.addEventListener('connected', (event) => this.onControllerConnected(event, 0));
        this.scene.add(controller1);
        this.controllers.push(controller1);

        const controllerGrip1 = this.renderer.xr.getControllerGrip(0);
        this.scene.add(controllerGrip1);
        this.controllerGrips.push(controllerGrip1);

        // Controller 2
        const controller2 = this.renderer.xr.getController(1);
        controller2.addEventListener('selectstart', () => this.onSelect());
        controller2.addEventListener('connected', (event) => this.onControllerConnected(event, 1));
        this.scene.add(controller2);
        this.controllers.push(controller2);

        const controllerGrip2 = this.renderer.xr.getControllerGrip(1);
        this.scene.add(controllerGrip2);
        this.controllerGrips.push(controllerGrip2);
    }

    onControllerConnected(event, index) {
        const controller = this.controllers[index];

        // Add visual representation
        const geometry = new THREE.CylinderGeometry(0.01, 0.02, 0.1, 8);
        const material = new THREE.MeshBasicMaterial({ color: 0xff0000 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.rotation.x = -Math.PI / 2;
        controller.add(mesh);

        console.log('Controller', index, 'connected:', event.data.gamepad);
    }

    onSelect() {
        console.log('Select triggered, robotPlaced:', this.robotPlaced, 'reticle visible:', this.reticle.visible);

        if (!this.robotPlaced) {
            // Place robot even without reticle if hit test fails
            if (this.reticle.visible) {
                this.placeRobot();
            } else {
                // Place at default position in front of user
                this.placeRobotAtDefault();
            }
        }
    }

    placeRobotAtDefault() {
        if (!this.robot) {
            this.createRobot();
        }

        // Get user position and place robot in front
        const camera = this.renderer.xr.getCamera();
        const userPos = new THREE.Vector3();
        camera.getWorldPosition(userPos);

        // Place robot 2 meters in front of user at floor level
        const robotPos = new THREE.Vector3(userPos.x, 0, userPos.z - 2);
        this.robot.position.copy(robotPos);
        this.robot.visible = true;
        this.robotPlaced = true;
        this.robotPosition.copy(robotPos);

        this.updateRobotStatus('Robot placed at default position');
        this.updateStatus('Robot placed! Use controllers to box');

        console.log('Robot placed at default:', robotPos);
    }

    placeRobot() {
        if (!this.robot) {
            this.createRobot();
        }

        // Get reticle world position
        const reticleWorldPos = new THREE.Vector3();
        this.reticle.getWorldPosition(reticleWorldPos);

        // Position robot at reticle location
        this.robot.position.copy(reticleWorldPos);
        this.robot.visible = true;
        this.robotPlaced = true;
        this.robotPosition.copy(reticleWorldPos);

        // Hide reticle
        this.reticle.visible = false;

        this.updateRobotStatus('Robot placed at target location');
        this.updateStatus('Robot placed! Use controllers to box');

        console.log('Robot placed at:', reticleWorldPos);
    }

    createRobot() {
        this.robot = new THREE.Group();

        // Materials
        const bodyMaterial = new THREE.MeshLambertMaterial({ color: 0x666666 });
        const jointMaterial = new THREE.MeshLambertMaterial({ color: 0x444444 });

        // Torso (main body)
        const torsoGeometry = new THREE.BoxGeometry(0.4, 0.6, 0.2);
        const torso = new THREE.Mesh(torsoGeometry, bodyMaterial);
        torso.position.y = 1.0; // 1.7m total height
        torso.castShadow = true;
        this.robot.add(torso);

        // Head
        const headGeometry = new THREE.BoxGeometry(0.25, 0.25, 0.25);
        const head = new THREE.Mesh(headGeometry, bodyMaterial);
        head.position.y = 1.4;
        head.castShadow = true;
        this.robot.add(head);

        // Arms setup (positioned at shoulders)
        this.createArm('left', -0.25, 1.2);
        this.createArm('right', 0.25, 1.2);

        // Legs
        this.createLeg('left', -0.1, 0.7);
        this.createLeg('right', 0.1, 0.7);

        this.robot.scale.setScalar(1.0); // 1.7m height
        this.scene.add(this.robot);

        // Initialize arms to forward boxing position
        this.updateArmIK('left', this.leftHandTarget);
        this.updateArmIK('right', this.rightHandTarget);
    }

    createArm(side, xOffset, yPos) {
        const armGroup = new THREE.Group();

        // Shoulder - positioned at robot sides
        const shoulderGeometry = new THREE.SphereGeometry(0.08);
        const shoulderMaterial = new THREE.MeshLambertMaterial({ color: 0x444444 });
        const shoulder = new THREE.Mesh(shoulderGeometry, shoulderMaterial);
        shoulder.position.set(xOffset, yPos, 0);
        armGroup.add(shoulder);

        // Upper arm - shorter, closer to shoulder
        const upperArmGeometry = new THREE.CylinderGeometry(0.05, 0.05, 0.2);
        const upperArmMaterial = new THREE.MeshLambertMaterial({ color: 0x666666 });
        const upperArm = new THREE.Mesh(upperArmGeometry, upperArmMaterial);
        upperArm.position.set(xOffset, yPos - 0.1, -0.02); // Much closer to shoulder
        upperArm.castShadow = true;
        armGroup.add(upperArm);

        // Elbow - right at upper arm end
        const elbowGeometry = new THREE.SphereGeometry(0.04);
        const elbow = new THREE.Mesh(elbowGeometry, shoulderMaterial);
        elbow.position.set(xOffset, yPos - 0.2, -0.04); // Right at upper arm end
        armGroup.add(elbow);

        // Forearm - starts right at elbow
        const forearmGeometry = new THREE.CylinderGeometry(0.04, 0.04, 0.15);
        const forearm = new THREE.Mesh(forearmGeometry, upperArmMaterial);
        forearm.position.set(xOffset, yPos - 0.275, -0.06); // Right at elbow
        forearm.rotation.z = Math.PI / 2; // Rotate 90 degrees for horizontal alignment
        forearm.castShadow = true;
        armGroup.add(forearm);

        // Hand/Glove - right at forearm end
        const handGeometry = new THREE.BoxGeometry(0.1, 0.1, 0.1);
        const handMaterial = new THREE.MeshLambertMaterial({ color: 0xff3333 });
        const hand = new THREE.Mesh(handGeometry, handMaterial);
        // Position hands right at forearm end
        const handSideOffset = side === 'left' ? -0.2 : 0.2;
        hand.position.set(handSideOffset, yPos - 0.35, -0.08); // Right at forearm end
        hand.castShadow = true;
        armGroup.add(hand);

        // Store references for IK
        armGroup.userData = {
            side: side,
            shoulder: shoulder,
            upperArm: upperArm,
            elbow: elbow,
            forearm: forearm,
            hand: hand,
            shoulderOffset: xOffset,
            handSideOffset: handSideOffset
        };

        this.robot.add(armGroup);
        this.robot.userData[side + 'Arm'] = armGroup;
    }

    createLeg(side, xOffset, yPos) {
        const legGroup = new THREE.Group();

        // Hip
        const hipGeometry = new THREE.SphereGeometry(0.08);
        const hipMaterial = new THREE.MeshLambertMaterial({ color: 0x444444 });
        const hip = new THREE.Mesh(hipGeometry, hipMaterial);
        hip.position.set(xOffset, yPos, 0);
        legGroup.add(hip);

        // Thigh
        const thighGeometry = new THREE.CylinderGeometry(0.08, 0.08, 0.4);
        const thighMaterial = new THREE.MeshLambertMaterial({ color: 0x666666 });
        const thigh = new THREE.Mesh(thighGeometry, thighMaterial);
        thigh.position.set(xOffset, yPos - 0.2, 0);
        thigh.castShadow = true;
        legGroup.add(thigh);

        // Knee
        const kneeGeometry = new THREE.SphereGeometry(0.06);
        const knee = new THREE.Mesh(kneeGeometry, hipMaterial);
        knee.position.set(xOffset, yPos - 0.4, 0);
        legGroup.add(knee);

        // Shin
        const shinGeometry = new THREE.CylinderGeometry(0.06, 0.06, 0.3);
        const shin = new THREE.Mesh(shinGeometry, thighMaterial);
        shin.position.set(xOffset, yPos - 0.55, 0);
        shin.castShadow = true;
        legGroup.add(shin);

        // Foot
        const footGeometry = new THREE.BoxGeometry(0.12, 0.06, 0.2);
        const footMaterial = new THREE.MeshLambertMaterial({ color: 0x333333 });
        const foot = new THREE.Mesh(footGeometry, footMaterial);
        foot.position.set(xOffset, yPos - 0.73, 0.05);
        foot.castShadow = true;
        legGroup.add(foot);

        this.robot.add(legGroup);
    }

    updateInput() {
        if (!this.xrSession) return;

        const inputSources = this.xrSession.inputSources;

        for (let i = 0; i < inputSources.length; i++) {
            const inputSource = inputSources[i];
            const gamepad = inputSource.gamepad;

            if (gamepad && gamepad.axes && gamepad.buttons) {
                // Left controller (movement)
                if (i === 0) {
                    this.inputState.leftStick.x = gamepad.axes[2] || 0; // thumbstick X
                    this.inputState.leftStick.y = gamepad.axes[3] || 0; // thumbstick Y

                    // A button for jumping
                    this.inputState.aPrevious = this.inputState.aButton;
                    this.inputState.aButton = gamepad.buttons[4] && gamepad.buttons[4].pressed; // A button
                }

                // Right controller (rotation)
                if (i === 1) {
                    this.inputState.rightStick.x = gamepad.axes[2] || 0;
                    this.inputState.rightStick.y = gamepad.axes[3] || 0;
                }
            }
        }
    }

    updateRobot(deltaTime) {
        if (!this.robot || !this.robotPlaced) return;

        const moveSpeed = 2.0; // meters per second
        const rotateSpeed = 3.0; // radians per second
        const jumpForce = 5.0;
        const gravity = -9.81;

        // Rotation (right stick X) - invert for natural rotation
        this.robotRotation -= this.inputState.rightStick.x * rotateSpeed * deltaTime;

        // Movement (left stick - relative to robot's facing direction)
        const forward = -this.inputState.leftStick.y * moveSpeed * deltaTime;
        const strafe = -this.inputState.leftStick.x * moveSpeed * deltaTime; // Invert strafe

        // Calculate movement in world space
        const cos = Math.cos(this.robotRotation);
        const sin = Math.sin(this.robotRotation);

        this.robotVelocity.x = forward * sin + strafe * cos;
        this.robotVelocity.z = forward * cos - strafe * sin;

        // Jumping
        if (this.inputState.aButton && !this.inputState.aPrevious && !this.isJumping) {
            this.jumpVelocity = jumpForce;
            this.isJumping = true;
        }

        // Apply gravity
        if (this.isJumping) {
            this.jumpVelocity += gravity * deltaTime;
            this.robotPosition.y += this.jumpVelocity * deltaTime;

            // Land
            if (this.robotPosition.y <= 0) {
                this.robotPosition.y = 0;
                this.jumpVelocity = 0;
                this.isJumping = false;
            }
        }

        // Update position
        this.robotPosition.x += this.robotVelocity.x;
        this.robotPosition.z += this.robotVelocity.z;

        // Apply transforms
        this.robot.position.copy(this.robotPosition);
        this.robot.rotation.y = this.robotRotation;

        // Damping
        this.robotVelocity.multiplyScalar(0.8);
    }

    updateHandTargets() {
        if (!this.robotPlaced) return;

        const xrCamera = this.renderer.xr.getCamera(this.camera);
        if (!xrCamera) return;

        const cameraMatrixWorldInverse = xrCamera.matrixWorld.clone().invert();
        const cameraQuaternion = xrCamera.getWorldQuaternion(new THREE.Quaternion());

        const cameraForward = new THREE.Vector3(0, 0, -1).applyQuaternion(cameraQuaternion);
        cameraForward.y = 0;
        if (cameraForward.lengthSq() < 1e-6) {
            cameraForward.set(0, 0, -1);
        }
        cameraForward.normalize();
        const cameraYaw = Math.atan2(cameraForward.x, cameraForward.z);

        const yawDifference = this.normalizeAngle(cameraYaw - this.robotRotation);
        const facingRobot = Math.abs(yawDifference) > Math.PI / 2;

        const rotationToRobot = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0),
            this.robotRotation - cameraYaw
        );

        const robotCameraPos = this.robotPosition.clone().applyMatrix4(cameraMatrixWorldInverse);

        this.currentForwardAxisLocal = new THREE.Vector3(0, 0, facingRobot ? -1 : 1);

        for (let i = 0; i < this.controllers.length; i++) {
            const controller = this.controllers[i];

            if (!controller || !controller.visible) continue;

            const controllerWorldPos = new THREE.Vector3();
            controller.getWorldPosition(controllerWorldPos);

            const controllerCameraPos = controllerWorldPos.clone().applyMatrix4(cameraMatrixWorldInverse);
            const relativeCamera = controllerCameraPos.sub(robotCameraPos);
            relativeCamera.applyQuaternion(rotationToRobot);

            if (facingRobot) {
                relativeCamera.x *= -1;
                relativeCamera.z *= -1;
            }

            const target = i === 0 ? this.leftHandTarget : this.rightHandTarget;
            target.copy(relativeCamera);

            if (i === 0) {
                target.x = THREE.MathUtils.clamp(target.x, -0.8, 0.2);
            } else {
                target.x = THREE.MathUtils.clamp(target.x, -0.2, 0.8);
            }

            target.y = THREE.MathUtils.clamp(target.y, 0.3, 1.6);

            const forwardAxis = this.currentForwardAxisLocal;
            const forwardComponent = target.dot(forwardAxis);
            const clampedForward = THREE.MathUtils.clamp(forwardComponent, -0.6, 0.8);
            target.add(forwardAxis.clone().multiplyScalar(clampedForward - forwardComponent));
        }

        this.updateArmIK('left', this.leftHandTarget);
        this.updateArmIK('right', this.rightHandTarget);
    }

    updateArmIK(side, target) {
        if (!this.robot || !this.robot.userData[side + 'Arm']) return;

        const arm = this.robot.userData[side + 'Arm'];
        const hand = arm.userData.hand;
        const forearm = arm.userData.forearm;
        const upperArm = arm.userData.upperArm;
        const elbow = arm.userData.elbow;
        const shoulder = arm.userData.shoulder;

        // Get current hand position relative to robot
        const currentHandPos = hand.position.clone();

        // Smoothly move towards target
        const lerpFactor = 0.15;
        currentHandPos.lerp(target, lerpFactor);

        const forwardAxis = (this.currentForwardAxisLocal && this.currentForwardAxisLocal.lengthSq() > 0)
            ? this.currentForwardAxisLocal.clone().normalize()
            : new THREE.Vector3(0, 0, 1);

        const shoulderToHand = currentHandPos.clone().sub(shoulderPos);
        const forwardDistance = shoulderToHand.dot(forwardAxis);
        const minForward = -0.3;
        const maxForward = 0.8;
        const clampedForward = THREE.MathUtils.clamp(forwardDistance, minForward, maxForward);
        if (Math.abs(clampedForward - forwardDistance) > 1e-4) {
            currentHandPos.add(forwardAxis.clone().multiplyScalar(clampedForward - forwardDistance));
        }

        // Two-bone IK calculation
        const shoulderPos = shoulder.position.clone();
        const upperArmLength = 0.3;
        const forearmLength = 0.25;
        const totalArmLength = upperArmLength + forearmLength;

        // Calculate distance to target
        const toTarget = currentHandPos.clone().sub(shoulderPos);
        const distance = toTarget.length();

        // Clamp distance to reachable range
        const clampedDistance = Math.min(distance, totalArmLength * 0.95);

        if (clampedDistance < 0.1) {
            const defaultX = side === 'left' ? -0.3 : 0.3;
            const defaultOffset = new THREE.Vector3(defaultX, -0.1, 0);
            defaultOffset.add(forwardAxis.clone().multiplyScalar(0.2));
            currentHandPos.copy(shoulderPos.clone().add(defaultOffset));
        }

        const direction = currentHandPos.clone().sub(shoulderPos).normalize();

        // Calculate elbow position - force it to bend forward
        const elbowOffset = new THREE.Vector3();

        // Start with direction from shoulder to hand
        elbowOffset.copy(direction);

        elbowOffset.add(forwardAxis.clone().multiplyScalar(0.5));

        // Add side bias for natural positioning
        const sideBias = side === 'left' ? -0.2 : 0.2;
        elbowOffset.x += sideBias;

        // Normalize and scale to upper arm length
        elbowOffset.normalize().multiplyScalar(upperArmLength);

        const elbowPos = shoulderPos.clone().add(elbowOffset);

        const elbowForward = elbowPos.clone().sub(shoulderPos).dot(forwardAxis);
        if (elbowForward < 0.1) {
            elbowPos.add(forwardAxis.clone().multiplyScalar(0.1 - elbowForward));
        }

        // Update positions
        hand.position.copy(currentHandPos);
        elbow.position.copy(elbowPos);

        // Update arm segment positions and orientations
        const shoulderToElbow = elbowPos.clone().sub(shoulderPos);
        const elbowToHand = currentHandPos.clone().sub(elbowPos);

        // Position and orient upper arm
        upperArm.position.copy(shoulderPos.clone().add(shoulderToElbow.clone().multiplyScalar(0.5)));
        upperArm.rotation.set(0, 0, 0); // Reset rotation
        upperArm.lookAt(elbowPos);

        // Position and orient forearm
        forearm.position.copy(elbowPos.clone().add(elbowToHand.clone().multiplyScalar(0.5)));
        forearm.rotation.set(0, 0, 0); // Reset rotation
        forearm.lookAt(currentHandPos);

        console.log(`${side} arm - Hand: ${currentHandPos.x.toFixed(2)}, ${currentHandPos.y.toFixed(2)}, ${currentHandPos.z.toFixed(2)}, Elbow: ${elbowPos.x.toFixed(2)}, ${elbowPos.y.toFixed(2)}, ${elbowPos.z.toFixed(2)}`);
    }

    render(time, frame) {
        if (frame && this.hitTestSource && !this.robotPlaced) {
            const hitTestResults = frame.getHitTestResults(this.hitTestSource);

            if (hitTestResults.length > 0) {
                const hit = hitTestResults[0];
                const pose = hit.getPose(this.xrReferenceSpace);

                this.reticle.visible = true;
                this.reticle.matrix.fromArray(pose.transform.matrix);
            } else {
                this.reticle.visible = false;
            }
        }

        // Update game logic
        const deltaTime = 0.016; // Approximate 60fps
        this.updateInput();
        this.updateRobot(deltaTime);
        this.updateHandTargets();

        this.renderer.render(this.scene, this.camera);
    }

    updateStatus(message) {
        document.getElementById('status').textContent = message;
    }

    updateRobotStatus(message) {
        document.getElementById('robotStatus').textContent = message;
    }

    normalizeAngle(angle) {
        return THREE.MathUtils.euclideanModulo(angle + Math.PI, Math.PI * 2) - Math.PI;
    }
}

// Initialize the game when the page loads
window.addEventListener('load', () => {
    new RealSteelARGame();
});